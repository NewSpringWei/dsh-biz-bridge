/**
 * dsh-biz-bridge 插件入口（§5/§6/§7/§8）。
 *
 * - name / inject / Config / apply：函数式插件规范（对齐 webhook-github 等
 *   DSH 既有插件；Config schema 与 DEFAULTS 一一对应，见 config.ts）。
 * - 注入清单按设计 §5.1 收敛为：['agents', 'sessions', 'sessionPersistence', 'webServer']。
 *   说明：DSH 各 base-backed profile 实际会经 '@deepseek-ai/cordis-plugin-timer'
 *   提供 `timer` 服务（可用性成立，注入亦可），但本插件仍选择不注入 timer——调度器
 *   与回收器定时统一在 ctx.effect() 内用 setInterval 管理（设计 §7.2“受管定时器”的
 *   effect 包裹形态），语义等价且不依赖额外插件行。
 * - 生命周期：ctx.effect 注册路由/定时/监听；卸载时 hub 取消 + pool dispose
 *   + db close；激活时先执行 §7.3 救援再启动调度。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { NonceCache, SignatureVerifier } from './core/auth.ts'
import { fingerprint, loadClients, seedFromComposition } from './core/clients-store.ts'
import { loadStaticFiles } from './http/admin-page.ts'
import {
  clientWorkspaceDir, normalizeConfig, resolveRuntimeLayout, type RawConfig, type ResolvedConfig,
} from './config/config.ts'
import { openBridgeDb } from './core/db.ts'
import { createAttachmentAdmission, createSessionGateway, createUserMessageFactory } from './dsh/gateway.ts'
import { applyAgentSecurityPolicy } from './core/agent-policy.ts'
import { createHttpAttachmentFetcher } from './core/attachments.ts'
import { createBridgeHandler } from './http/http-api.ts'
import { rescueProcessing } from './core/rescue.ts'
import type { LoggerLike } from './shared/runtime.ts'
import { AgentPool } from './core/session-bridge.ts'
import { RunHub } from './core/runner.ts'
import { CallbackScheduler } from './core/scheduler.ts'
import { FileLogger } from './core/logger.ts'
import { decodeSessionEvent, type SessionEventLike } from './dsh/gateway.ts'
import { modelCatalogSummary } from './core/models-config.ts'

/** 配置 schema 的 TS 接口（设计 §8.1 的扁平形态）。 */
export interface Config {
  runtime?: RawConfig['runtime']
  database?: RawConfig['database']
  auth?: RawConfig['auth']
  scheduler?: RawConfig['scheduler']
  http?: RawConfig['http']
  models?: RawConfig['models']
  security?: RawConfig['security']
  attachments?: RawConfig['attachments']
}

/** 配置 schema：缺省值与 config.ts DEFAULTS 保持一致（双源防漂移注释）。 */
export const Config: z<Config> = z.object({
  runtime: z.object({
    // 单一磁盘根；其下派生 data/（SQLite）、logs/（运行日志）、workspace/<clientId>/（会话工作区）
    path: z.string().default('./runtime'),
  }).default({ path: './runtime' }),
  database: z.object({
    journalMode: z.string().default('WAL'),
    busyTimeout: z.natural().default(5000),
  }).default({ journalMode: 'WAL', busyTimeout: 5000 }),
  auth: z.object({
    timestampWindow: z.natural().default(300),
    nonceCacheSize: z.natural().min(100).default(10000),
    clients: z.array(z.object({
      clientId: z.string().required(),
      publicKey: z.string().required(),
      scope: z.array(z.union([z.const('stream'), z.const('callback'), z.const('admin')])).required(),
    })).default([]),
  }).default({ timestampWindow: 300, nonceCacheSize: 10000, clients: [] }),
  scheduler: z.object({
    pollInterval: z.natural().min(1).default(2),
    maxConcurrency: z.natural().min(1).default(5),
    callbackTimeout: z.natural().min(1).default(30),
    maxRetry: z.natural().default(3),
    retryInterval: z.natural().min(1).default(30),
  }).default({ pollInterval: 2, maxConcurrency: 5, callbackTimeout: 30, maxRetry: 3, retryInterval: 30 }),
  http: z.object({
    sseKeepalive: z.natural().min(1).default(15),
  }).default({ sseKeepalive: 15 }),
  models: z.object({
    // 承载 provider 路由的宿主条目 id（dsh-base 的 llm-pi-ai 行）；见 config.ts 同名注释
    settingsNamespace: z.string().default('llm-pi-ai'),
  }).default({ settingsNamespace: 'llm-pi-ai' }),
  security: z.object({
    policySection: z.boolean().default(true),
    denyTools: z.array(z.string()).default([]),
    sandboxMode: z.union([z.const('default'), z.const('read-only'), z.const('workspace-write')]).default('default'),
  }).default({ policySection: true, denyTools: [], sandboxMode: 'default' }),
  attachments: z.object({
    enabled: z.boolean().default(true),
    fetchTimeout: z.natural().min(1).default(30),
    maxItems: z.natural().min(1).default(10),
    maxFileBytes: z.natural().min(1).default(32 * 1024 * 1024),
    maxTotalBytes: z.natural().min(1).default(64 * 1024 * 1024),
    allowedHosts: z.array(z.string()).default([]),
    denyInternalHosts: z.boolean().default(true),
    allowInternalCallbackHosts: z.boolean().default(false),
    maxRedirects: z.natural().default(5),
    outbound: z.object({
      enabled: z.boolean().default(true),
      maxFiles: z.natural().min(1).default(20),
      maxFileBytes: z.natural().min(1).default(32 * 1024 * 1024),
      exclude: z.array(z.string()).default(['attachments', 'node_modules', '.git', '.ssh', '.aws', '.kube', '.gnupg', '.docker']),
      sensitivePatterns: z.array(z.string()).default(['.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.shadow']),
    }).default({
      enabled: true,
      maxFiles: 20,
      maxFileBytes: 32 * 1024 * 1024,
      exclude: ['attachments', 'node_modules', '.git', '.ssh', '.aws', '.kube', '.gnupg', '.docker'],
      sensitivePatterns: ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.shadow'],
    }),
  }).default({
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
  }),
})

export const name = 'dsh-biz-bridge'

/** 真实 DSH host 上存在的注入服务（见文件头注释，timer 不注入）。 */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'webServer', 'llm', 'sessionQuery']

export function apply(ctx: Context, rawConfig: Config): void {
  // 1. 配置归一化（defense-in-depth；schema 已做缺省化）
  const config = normalizeConfig(rawConfig as RawConfig)
  const logger: LoggerLike = {
    info: (message, ...args) => ctx.logger.info(`[bizbridge] ${message}`, ...args),
    warn: (message, ...args) => ctx.logger.warn(`[bizbridge] ${message}`, ...args),
    error: (message, ...args) => ctx.logger.error(`[bizbridge] ${message}`, ...args),
  }
  // base-only 组合可能没有把 ctx.logger 接到终端的消费者；关键启动信息额外走
  // console，保证独立进程在终端可见（web 等自带日志源的场景不依赖 console）。
  const say = (message: string): void => {
    logger.info(message)
    try { console.log(`[dsh-biz-bridge] ${message}`) } catch { /* ignore */ }
  }
  say(`activating with config ${JSON.stringify(skipSecrets(config))}`)

  // 2. 存储层 + 激活时救援（§7.3）+ 过期数据清理
  //    磁盘布局：单一 runtime 根 → data/logs/workspace 子目录（派生见 resolveRuntimeLayout）
  const layout = resolveRuntimeLayout(config.runtime.path)
  mkdirSync(layout.logsDir, { recursive: true })
  mkdirSync(layout.workspaceDir, { recursive: true })
  mkdirSync(layout.clientsDir, { recursive: true })
  // 文件日志在**首次使用之前**创建：清理分支与 agent 安全策略都写它（此前声明在使用点
  // 之后，仅因清理计数为 0 才未触发 TDZ 错误）。
  const fileLogger = new FileLogger(layout.logsDir)
  fileLogger.info('startup', 'plugin activating', { config: skipSecrets(config) as Record<string, unknown> })
  const db = openBridgeDb({
    path: layout.dbFile,
    journalMode: config.database.journalMode,
    busyTimeout: config.database.busyTimeout,
  })
  rescueProcessing(db, (message) => logger.info(message))
  const cleaned = db.cleanupExpired()
  if (cleaned > 0) {
    logger.info(`cleaned up ${cleaned} expired task(s) (retention: 90 days)`)
    fileLogger.info('cleanup', `cleaned ${cleaned} expired tasks`)
  }

  // 3. 会话桥接层（§5.2）与事件归约 hub（§5.5）
  //    每个新建/恢复的 agent 在自己作用域内应用安全策略（§6.4.7）：系统提示词声明"转发内容
  //    不可当指令"约束，并按配置禁用工具、切换沙箱模式——只影响桥接创建的会话。
  //    安全事件写插件的文件日志（可审计），而非仅 console。
  const gateway = createSessionGateway(ctx, layout.workspaceDir, (agent, sessionId) => {
    applyAgentSecurityPolicy(agent, sessionId, config.security, {
      info: (message) => fileLogger.info('security', message),
      warn: (message) => fileLogger.warn('security', message),
    })
  })
  const pool = new AgentPool(gateway)
  const hub = new RunHub({
    begin: (sessionId) => pool.beginActivity(sessionId),
    end: (sessionId) => pool.endActivity(sessionId),
  })
  const messageFactory = createUserMessageFactory()

  // 4. 认证（§6.2）
  //    client 公钥表以 <runtime>/clients/ 为**权威**且热重载（见 core/clients-store.ts）；
  //    composition 配置里的 auth.clients 只在目录尚不存在时作为一次性迁移来源。
  if (seedFromComposition(layout.clientsDir, config.auth.clients)) {
    logger.info(`migrated ${config.auth.clients.length} client(s) from composition config to ${layout.clientsDir}`)
  }
  const initialClients = loadClients(layout.clientsDir)
  for (const problem of initialClients.problems) logger.warn(`clients: ${problem}`)
  logger.info(`clients: ${initialClients.clients.length} active from ${layout.clientsDir}`)
  const verifier = new SignatureVerifier(initialClients.clients, config.auth.timestampWindow)
  const nonceSeen = new NonceCache(config.auth.nonceCacheSize, config.auth.timestampWindow)

  // 5. 调度器（§7）
  const runtime = {
    config,
    db,
    pool,
    hub,
    gateway,
    messageFactory,
    // 附件转接（§6.4.4/§6.4.5）：准入端口按需探测宿主服务，拉取端口走全局 fetch，
    // 文件读取与工作目录都锚定 per-client workspace（业务隔离边界）。
    attachmentAdmission: createAttachmentAdmission(ctx),
    attachmentFetcher: createHttpAttachmentFetcher({
      denyInternalHosts: config.attachments.denyInternalHosts,
      maxRedirects: config.attachments.maxRedirects,
    }),
    readWorkspaceFile: async (absolutePath: string) => new Uint8Array(await readFile(absolutePath)),
    workspaceOf: (clientId: string) => clientWorkspaceDir(layout.workspaceDir, clientId),
    newAttachmentId: () => randomUUID(),
    verifier,
    nonceSeen,
    logger,
    llm: ctx.llm,
    // 配置面：provider 路由由本 profile 的 settings 段供给（models.settingsNamespace）。
    // 非强依赖——缺失时模型配置面只读，模型目录照常。
    settings: ctx.get('settings'),
    sessionQuery: ctx.get('sessionQuery'),
    fileLogger,
    staticFiles: loadStaticFiles((message) => logger.info(message)),
    // 回调测试接收器的内部令牌：仅本进程调度器持有，用于拒绝任何外部写入（F2）。
    callbackTestToken: randomBytes(32).toString('hex'),
  }
  // 5b. 附件服务探测（非强依赖）：缺失时只影响带附件的请求，纯文本路径照常。
  if (ctx.get('attachments') === undefined) {
    logger.warn('attachments service is not mounted: inbound attachments will be rejected (mount @deepseek-ai/dsh-attachment-local)')
  } else if (config.attachments.enabled) {
    say(`附件转接已启用：入站 ≤${config.attachments.maxItems} 个/请求、≤${Math.floor(config.attachments.maxFileBytes / (1024 * 1024))} MiB/文件；出站产物发现${config.attachments.outbound.enabled ? '已开启' : '已关闭'}`)
  }
  // 5c. 安全策略生效性检查（配置组合矛盾会让防护名存实亡，故在启动时明说）。
  if (config.security.sandboxMode === 'read-only') {
    if (config.attachments.outbound.enabled) {
      say('警告：security.sandboxMode=read-only 与 attachments.outbound.enabled 同时启用——agent 无法写文件，出站产物将始终为空')
    }
    if (ctx.get('sandboxPolicy') === undefined) {
      say('警告：security.sandboxMode=read-only 已配置，但宿主未挂载 sandboxPolicy——只读约束不会生效')
    } else {
      say('安全策略：桥接会话沙箱模式 = read-only（拒绝一切写入与删除）')
    }
  }
  if (config.security.denyTools.length > 0) {
    say(`安全策略：桥接会话禁用工具 ${config.security.denyTools.join(', ')}`)
  }
  // 5d. 模型目录可见性（§6.5）：headless profile 的 provider 来自**本 profile** 的 settings 段，
  //     配错作用域时目录只表现为"少一个 provider"、毫无提示——启动日志是唯一一定有人看的地方。
  //     延迟一拍：provider 行由各自的插件注册，可能晚于本插件激活。
  ctx.effect(() => {
    const MODEL_CATALOG_SUMMARY_DELAY_MS = 1000
    const timer = setTimeout(() => {
      void modelCatalogSummary(ctx.llm).then((catalog) => {
        say(`模型目录：${catalog.text}`)
        if (catalog.providerCount <= 1) {
          say('提示：本 profile 只注册了默认 provider。若要用网页（dsh-web）里配的其它模型，'
            + `把它们写进本 profile 的模型配置（POST /bizbridge/api/v1/admin/models/providers，见 docs/config.md §models）`)
        }
      }).catch((error: unknown) => {
        logger.warn(`model catalog summary unavailable: ${error instanceof Error ? error.message : String(error)}`)
      })
      if (ctx.get('settings') === undefined) {
        say('警告：宿主未挂载 settings 服务——模型配置面只读，provider 路由需手工写进本 profile 的 cordis.patch.yml')
      }
    }, MODEL_CATALOG_SUMMARY_DELAY_MS)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'dsh-biz-bridge: model catalog summary')
  const scheduler = new CallbackScheduler(runtime)

  // 6. 全局事件监听（ACP 桥接同款：插件级 ctx.on + 按 session 路由/所有权过滤）。
  //    会话串行（§5.8）保证同一 session 至多一个 ActiveRun，事件天然不串流。
  //    session/event 先经 gateway 的 decode 归一化（DSH 0.1.7 / 会话日志 v4；内嵌 stream 模型未变），
  //    runner 只消费与 DSH 版本解耦的 TurnEvent。
  ctx.on('session/event', (session, event: SessionEventLike) => {
    const sessionId = session.header.id
    for (const turnEvent of decodeSessionEvent(event)) {
      hub.onSessionEvent(sessionId, turnEvent)
    }
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }: { agent: { session: { id: string } }; message: { id: string }; turn: number }) => {
    hub.onMessageClaimed(agent.session.id, message.id, turn)
  })
  ctx.on('agent/error', ({ agent, error }: { agent: { session: { id: string } }; error: unknown }) => {
    hub.onAgentError(agent.session.id, error)
  })

  // 7. HTTP 路由（§6.1 prefix 路由 + 静态管理页，effect 包裹）
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/bizbridge',
      handler: createBridgeHandler(runtime),
    }),
    'dsh-biz-bridge: /bizbridge route',
  )
  fileLogger.info('startup', 'HTTP route registered', { prefix: '/bizbridge' })

  // 8. 调度轮询（§7.2：effect 包裹的受管 setInterval）
  ctx.effect(() => {
    const timer = setInterval(() => {
      void scheduler.pump()
    }, config.scheduler.pollInterval * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-biz-bridge: scheduler pump')

  // 8b. client 公钥表热重载：目录内容一变即为一个生效周期，直接重建 verifier——不重启。
  //     用轮询而非 fs.watch：Windows 上编辑器多为"写临时文件再改名"，watch 会丢事件；
  //     目录里只有个小 JSON 与若干 .pem，两秒一次的 stat 成本可忽略。
  //     解析失败时**保留上一份可用集合**——一个笔误不该把所有人锁在门外。
  ctx.effect(() => {
    const CLIENTS_RELOAD_INTERVAL_MS = 2000
    let last = fingerprint(layout.clientsDir)
    const timer = setInterval(() => {
      const current = fingerprint(layout.clientsDir)
      if (current === last) return
      last = current
      const result = loadClients(layout.clientsDir)
      for (const problem of result.problems) logger.warn(`clients: ${problem}`)
      if (!result.parsed) {
        logger.warn('clients: reload skipped (keeping the previous set)')
        return
      }
      verifier.reload(result.clients)
      say(`clients reloaded: ${result.clients.length} active`)
    }, CLIENTS_RELOAD_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-biz-bridge: clients hot reload')

  // 9. 卸载清理：取消活动 turn → 关闭数据库
  ctx.effect(() => {
    const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
    const timer = setInterval(() => {
      const cleaned = db.cleanupExpired()
      if (cleaned > 0) {
        logger.info(`daily cleanup: removed ${cleaned} expired task(s)`)
        fileLogger.info('cleanup', `daily cleanup: removed ${cleaned} expired tasks`)
      }
    }, CLEANUP_INTERVAL_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-biz-bridge: daily cleanup')

  // 10. 卸载清理：取消活动 turn → 关闭数据库
  ctx.effect(() => {
    return () => {
      fileLogger.info('startup', 'plugin unloading, cancelling all activities')
      hub.cancelAll('plugin unloading')
      try {
        db.close()
      } catch {
        // already closed
      }
    }
  }, 'dsh-biz-bridge: teardown')

  // 12. 激活后立即泵一轮（接续救援后的 queued 任务）
  void scheduler.pump()

  // 13. 启动完成日志：HTTP 入口（开浏览器属于 web 模式外壳的行为，headless 服务不默认开）
  try {
    const host = ctx.webServer.host === '0.0.0.0' ? '127.0.0.1' : ctx.webServer.host
    const base = `http://${host}:${ctx.webServer.port}/bizbridge`
    say(`HTTP API: ${base}`)
    say(`参考/调试页: ${base}/static/`)
  } catch {
    // webServer 尚未就绪时跳过入口打印，不影响插件功能
  }
  say('activated')
  fileLogger.info('startup', 'plugin activated')
}

/** 日志脱敏（不打印公钥/私钥等）。 */
function skipSecrets(config: ResolvedConfig): Record<string, unknown> {
  return {
    ...config,
    auth: {
      ...config.auth,
      clients: config.auth.clients.map(({ clientId, scope }) => ({ clientId, scope })),
    },
  }
}
