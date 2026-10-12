/**
 * 配置缺省值与运行时归一化（§8）。
 *
 * 磁盘布局单一根（草创期破坏性改版，版本仍为 0.1.0）：
 *   配置只声明 `runtime.path`（单个磁盘根），插件在其下派生固定子目录：
 *     <runtime>/data/      → SQLite（dsh-biz-bridge.db）
 *     <runtime>/logs/      → 运行日志（FileLogger 按天轮转）
 *     <runtime>/workspace/<clientId>/ → 每个业务 client 的会话工作目录
 *   runtime.path 支持绝对路径或相对 DSH 进程 cwd（由 resolveRuntimeLayout 归一化）。
 *
 * 设计文档 §8.1 以 schemastery z<Config> 声明配置；本文件是“纯 JS”侧的
 * 单一起源：normalizeConfig() 在 apply() 入口对 cordis 注入的（已被 schema
 * 校验/缺省化的）配置再做一次防御性合并与校验，并同时服务于单元测试。
 * index.ts 中导出的 `Config: z<Config>` schema 的缺省值必须与本文件 DEFAULT
 * 常量保持一致（两侧均有注释互指，防漂移）。
 */

import { isAbsolute, join, resolve } from 'node:path'
import type { AuthScope } from '../shared/types.ts'

/** 已解析的完整配置（与设计 §8.1 Config 接口一一对应）。 */
export interface ResolvedConfig {
  runtime: {
    /** 单一磁盘根（绝对路径；相对路径按 DSH 进程 cwd 解析，见 resolveRuntimeLayout）。 */
    path: string
  }
  database: {
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
  /** 模型面（§8.1）：provider 路由来自**本 profile** 的 settings 段。 */
  models: {
    /**
     * 承载 provider 路由的宿主条目 id（`dsh-base` 的 `llm-pi-ai` 行）。
     *
     * 桥接 profile 是 headless：`llm-pi-ai` 在 base 里休眠挂载，直到本 profile 的 settings
     * 段供上 provider 才注册路由。插件不自己注册 provider，只把这一段读/写封装成显式动作
     * （`POST /api/v1/admin/models/providers`）；改名或换适配器时改这一项即可。
     */
    settingsNamespace: string
    /**
     * 启动时从中同步 provider 段的源 profile 名（空 = 不同步，默认）。
     *
     * 部署形态决定它是什么：便携包用 `dsh-web.cmd`（`--profile web`）配模型，故那里应设 `web`；
     * 开发机上配模型的是 `desktop`。**必须显式给出**——猜错会让你以为同步生效了。
     */
    syncFromProfile: string
  }
  /** agent 侧安全策略（§6.4.7）：在桥接会话自己的作用域内生效。 */
  security: {
    /** 是否把"转发内容不可当指令"策略写入系统提示词（默认 true）。 */
    policySection: boolean
    /**
     * 在桥接会话中禁用的工具名（空数组 = 不限制，默认）。
     *
     * 这是**唯一的结构性约束**：它真正移除了 agent 的能力，而不是靠提示词说服模型。
     * 工具名随宿主工具集而定（如 `bash`、`pwsh`、`web_search`、`web_fetch`）；
     * 未知名字只记告警，不影响任务。
     */
    denyTools: string[]
    /**
     * 桥接会话的沙箱模式：`default`（不改动部署设定）/ `read-only`（拒绝一切写入与删除）/
     * `workspace-write`（允许写，仅限该会话工作目录）。
     *
     * `read-only` 是插件能做的最强结构性约束：模型即使被说服要写或删，也没有能力执行。
     * 代价是**出站产物发现失效**（agent 无法产出文件），二者不应同时启用。
     *
     * 注意：DSH 的读操作在所有模式下都不受边界限制，本项**不能**限制越界读取。
     */
    sandboxMode: 'default' | 'read-only' | 'workspace-write'
  }
  attachments: {
    /** 是否接受入站附件（关闭时提交体带 attachments 即 400）。 */
    enabled: boolean
    /** 拉取业务方 URI 的超时（秒）。 */
    fetchTimeout: number
    /** 单请求入站附件个数上限。 */
    maxItems: number
    /** 单个入站附件字节上限。 */
    maxFileBytes: number
    /** 单请求入站附件总字节上限。 */
    maxTotalBytes: number
    /** 允许拉取的 host（含端口）白名单；空数组 = 不限制。 */
    allowedHosts: string[]
    /** 是否拒绝内网/环回/链路本地地址（SSRF 防护，默认 true）。 */
    denyInternalHosts: boolean
    /**
     * 是否允许 `callback_url` 指向内网地址（默认 false）。
     *
     * 回调地址是插件主动发起的出站请求，默认与附件 URI 同样拒绝内网，避免被用作
     * 盲 SSRF 跳板。但**内网联调**（业务系统与插件同机/同内网）是常见场景，
     * 此时把它设为 `true`——只放开回调地址，附件 URI 仍受 `denyInternalHosts` 约束。
     */
    allowInternalCallbackHosts: boolean
    /** 重定向链最大跳数（默认 5）。 */
    maxRedirects: number
    /** 出站产物回传（§6.4.5）。 */
    outbound: {
      /** 是否发现并回传产物。 */
      enabled: boolean
      /** 单任务最多登记多少个产物。 */
      maxFiles: number
      /** 单个产物字节上限。 */
      maxFileBytes: number
      /** 快照时跳过的目录/文件名（含插件的 inbound 落盘区 attachments）。 */
      exclude: string[]
      /** 敏感文件 glob 模式（按文件名匹配排除，防数据泄露）。 */
      sensitivePatterns: string[]
    }
  }
}

/** 全部缺省值（设计 §8.3）。 */
export const DEFAULTS = {
  runtime: { path: './runtime' },
  database: { journalMode: 'WAL', busyTimeout: 5000 },
  auth: { timestampWindow: 300, nonceCacheSize: 10000, clients: [] },
  scheduler: {
    pollInterval: 2,
    maxConcurrency: 5,
    callbackTimeout: 30,
    maxRetry: 3,
    retryInterval: 30,
  },
  http: { sseKeepalive: 15 },
  models: { settingsNamespace: 'llm-pi-ai', syncFromProfile: '' },
  security: {
    policySection: true,
    denyTools: [],
    sandboxMode: 'default',
  },
  attachments: {
    enabled: true,
    fetchTimeout: 30,
    maxItems: 10,
    maxFileBytes: 32 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    allowedHosts: [],
    denyInternalHosts: true,
    allowInternalCallbackHosts: false,
    maxRedirects: 5,
    outbound: {
      enabled: true,
      maxFiles: 20,
      maxFileBytes: 32 * 1024 * 1024,
      exclude: ['attachments', 'node_modules', '.git', '.ssh', '.aws', '.kube', '.gnupg', '.docker'],
      sensitivePatterns: ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.shadow'],
    },
  },
} as const

/** 合法 scope 集合。 */
export const ALL_SCOPES: readonly AuthScope[] = ['stream', 'callback', 'admin']

export type RawConfig = Partial<{
  runtime: Partial<ResolvedConfig['runtime']>
  database: Partial<ResolvedConfig['database']>
  auth: Partial<{
    timestampWindow: number
    nonceCacheSize: number
    clients: Array<Partial<{ clientId: string; publicKey: string; scope: AuthScope[] }>>
  }>
  scheduler: Partial<ResolvedConfig['scheduler']>
  http: Partial<ResolvedConfig['http']>
  models: Partial<ResolvedConfig['models']>
  security: Partial<ResolvedConfig['security']>
  attachments: Partial<Omit<ResolvedConfig['attachments'], 'outbound'> & {
    outbound: Partial<ResolvedConfig['attachments']['outbound']>
  } & { denyInternalHosts?: boolean; maxRedirects?: number }>
}>

/** 由 runtime 根派生的磁盘布局（全部绝对路径）。 */
export interface RuntimeLayout {
  /** 归一化后的 runtime 根（绝对）。 */
  root: string
  dataDir: string
  logsDir: string
  workspaceDir: string
  /** client 公钥表目录：clients.json + <clientId>.pem，运行期热重载（见 core/clients-store.ts）。 */
  clientsDir: string
  /** SQLite 文件（位于 dataDir 下）。 */
  dbFile: string
}

/**
 * 归一化 runtime.path（相对路径按 DSH 进程 cwd）并派生固定子目录。
 * 目录本身不在此创建——由调用方（index.ts 激活 / gateway create 分支）幂等 mkdir。
 */
export function resolveRuntimeLayout(path: string): RuntimeLayout {
  const root = isAbsolute(path) ? path : resolve(process.cwd(), path)
  const dataDir = join(root, 'data')
  const logsDir = join(root, 'logs')
  const workspaceDir = join(root, 'workspace')
  const clientsDir = join(root, 'clients')
  return {
    root, dataDir, logsDir, workspaceDir, clientsDir, dbFile: join(dataDir, 'dsh-biz-bridge.db'),
  }
}

/** 某业务 client 的会话工作目录（= 其所有 agent 会话的 cwd，业务隔离边界）。 */
export function clientWorkspaceDir(workspaceDir: string, clientId: string): string {
  return join(workspaceDir, clientId)
}

function isPositiveInt(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`dsh-biz-bridge: config ${name} must be a non-negative safe integer`)
  }
}

/** 归一化原始配置 → ResolvedConfig（供 apply() 与单元测试复用）。 */
export function normalizeConfig(raw: RawConfig | undefined): ResolvedConfig {
  const input = raw ?? {}

  const runtime = { path: input.runtime?.path ?? DEFAULTS.runtime.path }
  if (typeof runtime.path !== 'string' || runtime.path.trim() === '') {
    throw new Error('dsh-biz-bridge: config runtime.path must be a non-empty string')
  }

  const database = {
    journalMode: input.database?.journalMode ?? DEFAULTS.database.journalMode,
    busyTimeout: input.database?.busyTimeout ?? DEFAULTS.database.busyTimeout,
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

  const models = {
    settingsNamespace: input.models?.settingsNamespace ?? DEFAULTS.models.settingsNamespace,
    syncFromProfile: input.models?.syncFromProfile ?? DEFAULTS.models.syncFromProfile,
  }
  if (typeof models.settingsNamespace !== 'string' || models.settingsNamespace.trim() === '') {
    throw new Error('dsh-biz-bridge: config models.settingsNamespace must be a non-empty string')
  }
  if (typeof models.syncFromProfile !== 'string') {
    throw new Error('dsh-biz-bridge: config models.syncFromProfile must be a string (empty disables syncing)')
  }
  if (models.syncFromProfile !== '' && !/^[A-Za-z0-9._-]+$/.test(models.syncFromProfile)) {
    throw new Error('dsh-biz-bridge: config models.syncFromProfile must be a profile name (letters/digits/._-) or empty')
  }

  const securityRaw = input.security ?? {}
  if (securityRaw.policySection !== undefined && typeof securityRaw.policySection !== 'boolean') {
    throw new Error('dsh-biz-bridge: config security.policySection must be a boolean')
  }
  const denyTools = securityRaw.denyTools ?? DEFAULTS.security.denyTools
  if (!Array.isArray(denyTools) || denyTools.some(name => typeof name !== 'string' || name.trim() === '')) {
    throw new Error('dsh-biz-bridge: config security.denyTools must be an array of non-empty strings')
  }
  const sandboxMode = securityRaw.sandboxMode ?? DEFAULTS.security.sandboxMode
  if (!['default', 'read-only', 'workspace-write'].includes(sandboxMode)) {
    throw new Error("dsh-biz-bridge: config security.sandboxMode must be one of 'default', 'read-only', 'workspace-write'")
  }
  const security = {
    policySection: securityRaw.policySection ?? DEFAULTS.security.policySection,
    denyTools: [...denyTools],
    sandboxMode,
  }

  const attachmentsRaw = input.attachments ?? {}
  const outboundRaw = attachmentsRaw.outbound ?? {}
  if (attachmentsRaw.enabled !== undefined && typeof attachmentsRaw.enabled !== 'boolean') {
    throw new Error('dsh-biz-bridge: config attachments.enabled must be a boolean')
  }
  if (outboundRaw.enabled !== undefined && typeof outboundRaw.enabled !== 'boolean') {
    throw new Error('dsh-biz-bridge: config attachments.outbound.enabled must be a boolean')
  }
  if (attachmentsRaw.denyInternalHosts !== undefined && typeof attachmentsRaw.denyInternalHosts !== 'boolean') {
    throw new Error('dsh-biz-bridge: config attachments.denyInternalHosts must be a boolean')
  }
  if (attachmentsRaw.allowInternalCallbackHosts !== undefined && typeof attachmentsRaw.allowInternalCallbackHosts !== 'boolean') {
    throw new Error('dsh-biz-bridge: config attachments.allowInternalCallbackHosts must be a boolean')
  }
  const attachments = {
    enabled: attachmentsRaw.enabled ?? DEFAULTS.attachments.enabled,
    fetchTimeout: attachmentsRaw.fetchTimeout ?? DEFAULTS.attachments.fetchTimeout,
    maxItems: attachmentsRaw.maxItems ?? DEFAULTS.attachments.maxItems,
    maxFileBytes: attachmentsRaw.maxFileBytes ?? DEFAULTS.attachments.maxFileBytes,
    maxTotalBytes: attachmentsRaw.maxTotalBytes ?? DEFAULTS.attachments.maxTotalBytes,
    allowedHosts: [...(attachmentsRaw.allowedHosts ?? DEFAULTS.attachments.allowedHosts)],
    denyInternalHosts: attachmentsRaw.denyInternalHosts ?? DEFAULTS.attachments.denyInternalHosts,
    allowInternalCallbackHosts: attachmentsRaw.allowInternalCallbackHosts ?? DEFAULTS.attachments.allowInternalCallbackHosts,
    maxRedirects: attachmentsRaw.maxRedirects ?? DEFAULTS.attachments.maxRedirects,
    outbound: {
      enabled: outboundRaw.enabled ?? DEFAULTS.attachments.outbound.enabled,
      maxFiles: outboundRaw.maxFiles ?? DEFAULTS.attachments.outbound.maxFiles,
      maxFileBytes: outboundRaw.maxFileBytes ?? DEFAULTS.attachments.outbound.maxFileBytes,
      exclude: [...(outboundRaw.exclude ?? DEFAULTS.attachments.outbound.exclude)],
      sensitivePatterns: [...(outboundRaw.sensitivePatterns ?? DEFAULTS.attachments.outbound.sensitivePatterns)],
    },
  }
  for (const key of ['fetchTimeout', 'maxItems', 'maxFileBytes', 'maxTotalBytes'] as const) {
    if (!Number.isSafeInteger(attachments[key]) || attachments[key] < 1) {
      throw new Error(`dsh-biz-bridge: config attachments.${key} must be a positive safe integer`)
    }
  }
  if (!Number.isSafeInteger(attachments.maxRedirects) || attachments.maxRedirects < 0) {
    throw new Error('dsh-biz-bridge: config attachments.maxRedirects must be a non-negative safe integer')
  }
  if (attachments.allowedHosts.some(host => typeof host !== 'string' || host.trim() === '')) {
    throw new Error('dsh-biz-bridge: config attachments.allowedHosts must be an array of non-empty strings')
  }
  for (const key of ['maxFiles', 'maxFileBytes'] as const) {
    if (!Number.isSafeInteger(attachments.outbound[key]) || attachments.outbound[key] < 1) {
      throw new Error(`dsh-biz-bridge: config attachments.outbound.${key} must be a positive safe integer`)
    }
  }
  if (attachments.outbound.exclude.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error('dsh-biz-bridge: config attachments.outbound.exclude must be an array of non-empty strings')
  }

  return {
    runtime,
    database,
    auth: { timestampWindow, nonceCacheSize, clients },
    scheduler,
    http,
    models,
    security,
    attachments,
  }
}
