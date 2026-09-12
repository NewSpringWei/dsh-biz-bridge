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
import { randomBytes } from 'node:crypto'
import { NonceCache, SignatureVerifier } from './core/auth.ts'
import { fingerprint, loadClients, seedFromComposition } from './core/clients-store.ts'
import { loadStaticFiles } from './http/admin-page.ts'
import {
  normalizeConfig, resolveRuntimeLayout, type RawConfig, type ResolvedConfig,
} from './config/config.ts'
import { openBridgeDb } from './core/db.ts'
import { createSessionGateway, createTextMessageFactory } from './dsh/gateway.ts'
import { createBridgeHandler } from './http/http-api.ts'
import { rescueProcessing } from './core/rescue.ts'
import type { LoggerLike } from './shared/runtime.ts'
import { AgentPool } from './core/session-bridge.ts'
import { RunHub } from './core/runner.ts'
import { CallbackScheduler } from './core/scheduler.ts'
import { FileLogger } from './core/logger.ts'
import { decodeSessionEvent, type SessionEventLike } from './dsh/gateway.ts'

/** 配置 schema 的 TS 接口（设计 §8.1 的扁平形态）。 */
export interface Config {
  runtime?: RawConfig['runtime']
  database?: RawConfig['database']
  auth?: RawConfig['auth']
  scheduler?: RawConfig['scheduler']
  http?: RawConfig['http']
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
  const gateway = createSessionGateway(ctx, layout.workspaceDir)
  const pool = new AgentPool(gateway)
  const hub = new RunHub({
    begin: (sessionId) => pool.beginActivity(sessionId),
    end: (sessionId) => pool.endActivity(sessionId),
  })
  const messageFactory = createTextMessageFactory()

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
  const fileLogger = new FileLogger(layout.logsDir)
  fileLogger.info('startup', 'plugin activating', { config: skipSecrets(config) as Record<string, unknown> })
  const runtime = {
    config,
    db,
    pool,
    hub,
    gateway,
    messageFactory,
    verifier,
    nonceSeen,
    logger,
    llm: ctx.llm,
    sessionQuery: ctx.get('sessionQuery'),
    fileLogger,
    staticFiles: loadStaticFiles((message) => logger.info(message)),
    // 回调测试接收器的内部令牌：仅本进程调度器持有，用于拒绝任何外部写入（F2）。
    callbackTestToken: randomBytes(32).toString('hex'),
  }
  const scheduler = new CallbackScheduler(runtime)

  // 6. 全局事件监听（ACP 桥接同款：插件级 ctx.on + 按 session 路由/所有权过滤）。
  //    会话串行（§5.8）保证同一 session 至多一个 ActiveRun，事件天然不串流。
  //    session/event 先经 gateway 的 decode 归一化（DSH 0.1.5 v3 流模型），
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
