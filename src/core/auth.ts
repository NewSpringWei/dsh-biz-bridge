/**
 * 签名验签与 nonce 防重放（§6.2）。
 *
 * 签名串 = HTTP_METHOD + REQUEST_PATH + X-Timestamp + X-Nonce + SHA256(请求体)
 * X-Signature = base64(RSA-SHA256(私钥, 签名串))
 * 口径（§6.2.2）：REQUEST_PATH 为完整 pathname（含插件前缀如 /bizbridge/api/v1/stream）、不含 query；SHA256 输出十六进制小写。
 *
 * 验签步骤（§6.2.3）：1 查公钥 → 2 时间戳容差 → 3 nonce 未重用（查询）
 * → 4 用公钥验签 → 通过后才登记 nonce（同步流程内无竞态）。
 * 纯 Node 内置模块实现，无外部依赖，可单元测试。
 */

import { createHash, createVerify, randomUUID } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { UnauthorizedError } from '../shared/errors.ts'
import type { AuthScope } from '../shared/types.ts'

export const AUTH_HEADERS = ['x-client-id', 'x-timestamp', 'x-nonce', 'x-signature'] as const

/** 认证后的调用者身份。 */
export interface Caller {
  clientId: string
  scope: AuthScope[]
}

/** 非对称验签器：从 client 白名单解析调用者并校验签名。 */
export class SignatureVerifier {
  /** clientId → { publicKey, scope }（normalizeConfig 已保证非空）。 */
  private readonly clients = new Map<string, { publicKey: string; scope: AuthScope[] }>()
  private readonly timestampWindowSeconds: number

  constructor(
    clients: ReadonlyArray<{ clientId: string; publicKey: string; scope: AuthScope[] }>,
    timestampWindowSeconds: number,
  ) {
    this.timestampWindowSeconds = timestampWindowSeconds
    for (const client of clients) this.clients.set(client.clientId, client)
  }

  /**
   * 验签入口。任一步失败抛 UnauthorizedError（§6.2.3 步骤 1..4）。
   * @param headers 请求头（小写键，node http 解析后的形态）
   * @param method HTTP 方法（大写）
   * @param pathname 完整 pathname（含插件前缀），不含 query
   * @param rawBody 原始请求体字节（SHA256 对象）
   * @param nonceSeen nonce 防重放存取（has 查询 + store 登记分离，保证验签失败不消耗 nonce）
   */
  verify(
    headers: IncomingHttpHeaders,
    method: string,
    pathname: string,
    rawBody: Buffer,
    nonceSeen: NonceSeen,
  ): Caller {
    const clientId = headerOf(headers, 'x-client-id')
    const timestamp = headerOf(headers, 'x-timestamp')
    const nonce = headerOf(headers, 'x-nonce')
    const signature = headerOf(headers, 'x-signature')

    // 步骤 1：查找公钥
    const client = this.clients.get(clientId)
    if (client === undefined) throw new UnauthorizedError(`unknown client "${clientId}"`)
    // 步骤 2：时间戳容差
    const nowSeconds = Math.floor(Date.now() / 1000)
    if (!/^\d{1,13}$/.test(timestamp)) {
      throw new UnauthorizedError('timestamp must be a unix-seconds integer')
    }
    const ts = Number(timestamp)
    if (!Number.isSafeInteger(ts) || Math.abs(nowSeconds - ts) > this.timestampWindowSeconds) {
      throw new UnauthorizedError('timestamp is outside the acceptance window')
    }
    // 步骤 3：nonce 未重用（只查询，不登记）
    if (nonceSeen.has(`${clientId}:${nonce}`)) {
      throw new UnauthorizedError(`nonce replay detected for client "${clientId}"`)
    }
    // 步骤 4：验签
    const signString = buildSignString(method, pathname, timestamp, nonce, rawBody)
    if (!verifySignature(client.publicKey, signString, signature)) {
      throw new UnauthorizedError('signature verification failed')
    }
    // 通过后登记 nonce（同步执行，无并发窗口）
    nonceSeen.store(`${clientId}:${nonce}`, nowSeconds)
    return { clientId, scope: [...client.scope] }
  }

  /** 调用者是否拥有指定 scope。 */
  hasScope(caller: Caller, scope: AuthScope): boolean {
    return caller.scope.includes(scope)
  }
}

/** 取单值请求头（防数组污染）。 */
function headerOf(headers: IncomingHttpHeaders, key: string): string {
  const value = headers[key]
  if (typeof value !== 'string' || value === '') {
    throw new UnauthorizedError(`missing required header ${key.toUpperCase()}`)
  }
  return value
}

/** 构造签名串（§6.2.2）。 */
export function buildSignString(
  method: string,
  pathname: string,
  timestamp: string,
  nonce: string,
  rawBody: Buffer,
): string {
  const digest = createHash('sha256').update(rawBody).digest('hex')
  return `${method}${pathname}${timestamp}${nonce}${digest}`
}

/** 用 PEM 公钥验 RSA-SHA256 签名（X-Signature 为 base64）。 */
export function verifySignature(publicKeyPem: string, signString: string, signatureBase64: string): boolean {
  try {
    return createVerify('sha256')
      .update(signString)
      .verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/**
 * nonce 防重放最小接口（has 查询与 store 登记分离，便于测试注入与
 * 验签失败不消耗 nonce 的语义）。
 */
export interface NonceSeen {
  has(key: string): boolean
  store(key: string, nowSeconds: number): void
}

/**
 * 带窗口淘汰的内存 nonce 缓存（§6.2.4）：Map 保持插入序，超窗与超容按序淘汰。
 * 进程重启即清空，重启窗口内的理论重放由 UNIQUE(client_id, biz_id, replay_seq)
 * 兜底为 409（§6.2.4 / §9）。
 */
export class NonceCache implements NonceSeen {
  private readonly entries = new Map<string, number>()
  private readonly maxSize: number
  private readonly windowSeconds: number

  constructor(maxSize: number, windowSeconds: number) {
    this.maxSize = maxSize
    this.windowSeconds = windowSeconds
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  /** 登记；先淘汰超窗条目，再按容量淘汰最旧（Map 插入序即时间序）。 */
  store(key: string, nowSeconds: number): void {
    this.prune(nowSeconds)
    this.entries.set(key, nowSeconds)
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** 淘汰早于窗口的登记项（entries 插入有序，命中即止）。 */
  prune(nowSeconds: number): void {
    for (const [key, at] of this.entries) {
      if (nowSeconds - at > this.windowSeconds) this.entries.delete(key)
      else break
    }
  }

  /** 测试/统计用。 */
  size(): number {
    return this.entries.size
  }
}

/** 空实现（测试或显式关闭防重放时用）。 */
export class NoopNonceSeen implements NonceSeen {
  has(): boolean {
    return false
  }

  store(): void {
    // no-op
  }
}

/** 生成 X-Nonce 建议值（业务侧工具）。 */
export function newNonce(): string {
  return randomUUID()
}
