/**
 * client 公钥表 —— 插件**自有**的热重载存储。
 *
 * 为什么不放在 composition 配置里：`cordis.patch.yml` 是**冷配置**（改它不会热生效，
 * 实测需重启），而 client 是业务配置——每次接入一个业务系统都要停服重启并不合理。
 *
 * 为什么不用 DSH 的 `ctx.settings`：那会把"信任根存在哪、什么格式、怎么校验"绑到
 * 上游的结构上，而上游怎么变不可控。这里用插件自己的目录与格式，**自足**。
 *
 * 目录形态（`<runtime>/clients/`）：
 *
 *     clients.json          元数据：[{ clientId, scope, enabled? }]
 *     <clientId>.pem        该 client 的 RSA 公钥（SPKI PEM，整段原文）
 *
 * 为什么元数据与公钥分成两个文件：JSON 没有块标量，PEM 塞进 JSON 只能写成带 `\n`
 * 的单行转义字符串——恰恰是运维最容易贴错的形式。`.pem` 文件让公钥保持整段原文，
 * 从工具页复制粘贴即可，零转义。
 *
 * 为什么是 JSON 而不是 YAML：插件**零运行时依赖**，没有 YAML 解析器；`JSON.parse`
 * 是内置的。（代价：JSON 不能写注释——所以目录说明放在 `runtime/README.txt`。）
 *
 * 热重载：调用方（index.ts）按固定间隔比对 {@link fingerprint}，变化时 {@link loadClients}
 * 并重建 verifier。**解析失败不清空既有 client**（见 `parsed`），避免一个笔误把所有人
 * 锁在门外。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_SCOPES } from '../config/config.ts'
import type { AuthScope } from '../shared/types.ts'

/** 一个可用 client（与 auth 层消费的形状一致）。 */
export interface ClientEntry {
  clientId: string
  publicKey: string
  scope: AuthScope[]
}

export interface ClientsLoadResult {
  /** 可用的 client 集合（enabled 且公钥可读）。 */
  clients: ClientEntry[]
  /** 面向运维的问题清单；已尽力降级，不抛错。 */
  problems: string[]
  /**
   * `clients.json` 是否存在且可解析。
   * - `true` → `clients` 是权威结果（可能是空集，表示运维有意清空 → fail-closed）
   * - `false` → 调用方应**保留上一份可用集合**，只记问题
   */
  parsed: boolean
}

/** clientId 白名单字符：它会被拼进内部 session id 与 workspace 目录名，必须收敛。 */
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const META_FILE = 'clients.json'

export function clientsFile(dir: string): string {
  return join(dir, META_FILE)
}

export function publicKeyFile(dir: string, clientId: string): string {
  return join(dir, `${clientId}.pem`)
}

/**
 * 目录内容的轻量指纹（只看 `clients.json` 与 `*.pem` 的名字/大小/修改时间）。
 * 用于轮询判断"是否需要重新装载"，避免每次 tick 都解析文件。
 */
export function fingerprint(dir: string): string {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 'absent'
  }
  const parts: string[] = []
  for (const name of names.sort()) {
    if (name !== META_FILE && !name.endsWith('.pem')) continue
    try {
      const stat = statSync(join(dir, name))
      parts.push(`${name}:${stat.size}:${stat.mtimeMs}`)
    } catch {
      parts.push(`${name}:unreadable`)
    }
  }
  return parts.join('|')
}

/** 装载 client 集合。永不抛错：问题进 `problems`，由调用方决定是否采用结果。 */
export function loadClients(dir: string): ClientsLoadResult {
  const problems: string[] = []
  const file = clientsFile(dir)
  if (!existsSync(file)) {
    return { clients: [], problems: [`${META_FILE} 不存在（${dir}）`], parsed: false }
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { clients: [], problems: [`${META_FILE} 不是合法 JSON：${(error as Error).message}`], parsed: false }
  }

  const list = Array.isArray(raw)
    ? raw
    : (raw !== null && typeof raw === 'object' && Array.isArray((raw as { clients?: unknown }).clients)
      ? (raw as { clients: unknown[] }).clients
      : undefined)
  if (list === undefined) {
    return { clients: [], problems: [`${META_FILE} 顶层应为 { "clients": [...] }（或数组）`], parsed: false }
  }

  const clients: ClientEntry[] = []
  const seen = new Set<string>()
  list.forEach((entry, index) => {
    const at = `${META_FILE}[${index}]`
    if (entry === null || typeof entry !== 'object') { problems.push(`${at} 不是对象，已跳过`); return }
    const { clientId, scope, enabled } = entry as { clientId?: unknown; scope?: unknown; enabled?: unknown }

    if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) {
      problems.push(`${at}.clientId 非法（只允许字母/数字/_/-，1..64 位），已跳过`)
      return
    }
    if (seen.has(clientId)) { problems.push(`${at}.clientId "${clientId}" 重复，已跳过`); return }
    if (!Array.isArray(scope) || scope.length === 0
      || scope.some((s) => !ALL_SCOPES.includes(s as AuthScope))) {
      problems.push(`${at}.scope 非法（应为 ${ALL_SCOPES.join(' / ')} 的非空数组），已跳过`)
      return
    }
    if (enabled === false) { problems.push(`${at} "${clientId}" enabled:false，已停用`); seen.add(clientId); return }

    const pemFile = publicKeyFile(dir, clientId)
    if (!existsSync(pemFile)) {
      problems.push(`${at} "${clientId}" 缺少公钥文件 ${clientId}.pem，已跳过`)
      return
    }
    const publicKey = readFileSync(pemFile, 'utf8').trim()
    if (publicKey === '') {
      problems.push(`${at} "${clientId}" 的公钥文件为空，已跳过`)
      return
    }
    seen.add(clientId)
    clients.push({ clientId, publicKey, scope: scope as AuthScope[] })
  })

  return { clients, problems, parsed: true }
}

/**
 * 一次性迁移：`clients.json` 不存在而 composition 配置里有 client 时，
 * 把它们落成目录形态，让旧部署无缝过渡到热重载存储。
 * @returns 是否写入了文件
 */
export function seedFromComposition(dir: string, clients: ReadonlyArray<ClientEntry>): boolean {
  if (clients.length === 0 || existsSync(clientsFile(dir))) return false
  mkdirSync(dir, { recursive: true })
  for (const client of clients) {
    writeFileSync(publicKeyFile(dir, client.clientId), `${client.publicKey.trim()}\n`, 'utf8')
  }
  writeFileSync(clientsFile(dir),
    `${JSON.stringify({
      clients: clients.map(({ clientId, scope }) => ({ clientId, scope, enabled: true })),
    }, null, 2)}\n`, 'utf8')
  return true
}
