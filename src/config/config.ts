/**
 * 配置缺省值与运行时归一化（§8）。
 *
 * 设计文档 §8.1 以 schemastery z<Config> 声明配置；本文件是“纯 JS”侧的
 * 单一起源：normalizeConfig() 在 apply() 入口对 cordis 注入的（已被 schema
 * 校验/缺省化的）配置再做一次防御性合并与校验，并同时服务于单元测试。
 * index.ts 中导出的 `Config: z<Config>` schema 的缺省值必须与本文件 DEFAULT
 * 常量保持一致（两侧均有注释互指，防漂移）。
 */

import type { AuthScope } from '../shared/types.ts'

/** 已解析的完整配置（与设计 §8.1 Config 接口一一对应）。 */
export interface ResolvedConfig {
  database: {
    /** SQLite 文件路径（相对路径按 DSH 进程 cwd 解析，见 db.ts openBridgeDb）。 */
    path: string
    journalMode: string
    busyTimeout: number
  }
  auth: {
    timestampWindow: number
    nonceCacheSize: number
    clients: Array<{
      clientId: string
      publicKey: string
      scope: AuthScope[]
    }>
  }
  scheduler: {
    pollInterval: number
    maxConcurrency: number
    callbackTimeout: number
    maxRetry: number
    retryInterval: number
  }
  http: {
    /** SSE keepalive 注释行间隔（秒），设计 §6.4.1 默认 15。 */
    sseKeepalive: number
  }
  logging: {
    /** 运行日志目录（绝对路径；相对路径按进程 cwd 解析）。 */
    path: string
  }
}

/** 全部缺省值（设计 §8.3）。 */
export const DEFAULTS = {
  database: { path: './data/dsh_biz_bridge.db', journalMode: 'WAL', busyTimeout: 5000 },
  auth: { timestampWindow: 300, nonceCacheSize: 10000, clients: [] },
  scheduler: {
    pollInterval: 2,
    maxConcurrency: 5,
    callbackTimeout: 30,
    maxRetry: 3,
    retryInterval: 30,
  },
  http: { sseKeepalive: 15 },
  logging: { path: './logs' },
} as const

/** 合法 scope 集合。 */
export const ALL_SCOPES: readonly AuthScope[] = ['stream', 'callback', 'admin']

export type RawConfig = Partial<{
  database: Partial<ResolvedConfig['database']>
  auth: Partial<{
    timestampWindow: number
    nonceCacheSize: number
    clients: Array<Partial<{ clientId: string; publicKey: string; scope: AuthScope[] }>>
  }>
  scheduler: Partial<ResolvedConfig['scheduler']>
  agent: Partial<ResolvedConfig['agent']>
  http: Partial<ResolvedConfig['http']>
  logging: Partial<ResolvedConfig['logging']>
}>

function isPositiveInt(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dsh-biz-bridge: config ${name} must be a non-negative safe integer`)
  }
}

/** 归一化原始配置 → ResolvedConfig（供 apply() 与单元测试复用）。 */
export function normalizeConfig(raw: RawConfig | undefined): ResolvedConfig {
  const input = raw ?? {}

  const database = {
    path: input.database?.path ?? DEFAULTS.database.path,
    journalMode: input.database?.journalMode ?? DEFAULTS.database.journalMode,
    busyTimeout: input.database?.busyTimeout ?? DEFAULTS.database.busyTimeout,
  }
  if (typeof database.path !== 'string' || database.path.trim() === '') {
    throw new Error('dsh-biz-bridge: config database.path must be a non-empty string')
  }
  if (typeof database.journalMode !== 'string' || database.journalMode.trim() === '') {
    throw new Error('dsh-biz-bridge: config database.journalMode must be a non-empty string')
  }
  isPositiveInt(database.busyTimeout, 'database.busyTimeout')

  const authRaw = input.auth ?? {}
  const timestampWindow = authRaw.timestampWindow ?? DEFAULTS.auth.timestampWindow
  const nonceCacheSize = authRaw.nonceCacheSize ?? DEFAULTS.auth.nonceCacheSize
  isPositiveInt(timestampWindow, 'auth.timestampWindow')
  if (!Number.isSafeInteger(nonceCacheSize) || nonceCacheSize < 1) {
    throw new Error('dsh-biz-bridge: config auth.nonceCacheSize must be a positive safe integer')
  }
  const clients = (authRaw.clients ?? DEFAULTS.auth.clients).map((client, index) => {
    if (typeof client.clientId !== 'string' || client.clientId.trim() === '') {
      throw new Error(`dsh-biz-bridge: config auth.clients[${index}].clientId must be a non-empty string`)
    }
    if (typeof client.publicKey !== 'string' || client.publicKey.trim() === '') {
      throw new Error(`dsh-biz-bridge: config auth.clients[${index}].publicKey must be a non-empty PEM string`)
    }
    const scope = client.scope ?? []
    if (!Array.isArray(scope) || scope.some(entry => !ALL_SCOPES.includes(entry as AuthScope))) {
      throw new Error(`dsh-biz-bridge: config auth.clients[${index}].scope must be a subset of [${ALL_SCOPES.join(', ')}]`)
    }
    return { clientId: client.clientId, publicKey: client.publicKey, scope: [...scope] }
  })

  const schedulerRaw = input.scheduler ?? {}
  const scheduler = {
    pollInterval: schedulerRaw.pollInterval ?? DEFAULTS.scheduler.pollInterval,
    maxConcurrency: schedulerRaw.maxConcurrency ?? DEFAULTS.scheduler.maxConcurrency,
    callbackTimeout: schedulerRaw.callbackTimeout ?? DEFAULTS.scheduler.callbackTimeout,
    maxRetry: schedulerRaw.maxRetry ?? DEFAULTS.scheduler.maxRetry,
    retryInterval: schedulerRaw.retryInterval ?? DEFAULTS.scheduler.retryInterval,
  }
  for (const key of ['pollInterval', 'maxConcurrency', 'callbackTimeout', 'maxRetry', 'retryInterval'] as const) {
    if (!Number.isSafeInteger(scheduler[key]) || scheduler[key] < 1) {
      throw new Error(`dsh-biz-bridge: config scheduler.${key} must be a positive safe integer`)
    }
  }

  const http = { sseKeepalive: input.http?.sseKeepalive ?? DEFAULTS.http.sseKeepalive }
  if (!Number.isSafeInteger(http.sseKeepalive) || http.sseKeepalive < 1) {
    throw new Error('dsh-biz-bridge: config http.sseKeepalive must be a positive safe integer')
  }

  const logging = { path: input.logging?.path ?? DEFAULTS.logging.path }
  if (typeof logging.path !== 'string' || logging.path.trim() === '') {
    throw new Error('dsh-biz-bridge: config logging.path must be a non-empty string')
  }

  return { database, auth: { timestampWindow, nonceCacheSize, clients }, scheduler, http, logging }
}
