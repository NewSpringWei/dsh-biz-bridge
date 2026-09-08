/**
 * HTTP 路由与处理器装配（§6.1/§6.3/§6.4/§6.5）。
 *
 * 统一前缀 /bizbridge（webServer kind:'prefix'），路径内自路由：
 *   POST …/api/v1/stream            流式响应（SSE）
 *   POST …/api/v1/callback          回调响应（入队）
 *   POST …/api/v1/tasks/list        任务列表
 *   POST …/api/v1/tasks/{id}        详情
 *   POST …/api/v1/tasks/{id}/logs   日志
 *   POST …/api/v1/tasks/{id}/cancel 取消
 *   POST …/api/v1/tasks/{id}/replay 重播
 *   POST …/api/v1/tasks/{id}/priority 优先级
 *   POST …/api/v1/stats             统计
 *   POST …/api/v1/sessions/{id}/messages  会话消息查询
 *   POST …/api/v1/callback-test/receive   回调测试接收（免签名）
 *   POST …/api/v1/callback-test/{id}      回调测试状态查询
 *   GET  …/static/*                第一方参考/调试页面（index/admin/client/utils，免签名）
 *
 * 除静态页外均需签名头（§6.2）。路由 handler 拥有完整响应生命周期（§6.1）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { ForbiddenError, NotFoundError } from '../shared/errors.ts'
import { internalSessionId } from '../shared/session-id.ts'
import { parseJsonBody, readBody, sendError, writeJson } from './http-util.ts'
import {
  cancelOp, detailOp, listOp, logsOp, priorityOp, replayOp, statsOp, sessionMessagesOp,
} from '../core/ops.ts'
import type { BridgeRuntime } from '../shared/runtime.ts'
import { validateSubmitInput } from '../core/submission.ts'
import { handleStreamSubmit } from './stream.ts'
import { nowIso } from '../core/db.ts'

/** 解析 URL pathname。 */
function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/'
  try {
    return new URL(raw, 'http://localhost').pathname
  } catch {
    return raw.split('?')[0] ?? '/'
  }
}

const STATIC_PREFIX = '/bizbridge/static'

function contentTypeOf(name: string): string {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8'
  if (name.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (name.endsWith('.css')) return 'text/css; charset=utf-8'
  if (name.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

/**
 * 第一方参考/调试页面静态服务（GET/HEAD，免签名）：
 *   /bizbridge/static[/]            → index.html（入口导航）
 *   /bizbridge/static/<name>[.html] → 同名资源（admin/client/utils 及 common.js/style.css）
 */
function serveStatic(runtime: BridgeRuntime, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (pathname !== STATIC_PREFIX && !pathname.startsWith(`${STATIC_PREFIX}/`)) return false
  let name: string
  if (pathname === STATIC_PREFIX || pathname === `${STATIC_PREFIX}/`) {
    name = 'index.html'
  } else {
    const rel = pathname.slice(STATIC_PREFIX.length + 1)
    if (!/^[A-Za-z0-9._-]+$/.test(rel)) return false
    name = rel.includes('.') ? rel : `${rel}.html`
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { error: { code: 'INVALID_REQUEST', message: 'method not allowed', details: {} } })
    return true
  }
  const body = runtime.staticFiles[name]
  if (body === undefined) {
    writeJson(res, 404, { error: { code: 'NOT_FOUND', message: `static asset not found: ${name}`, details: {} } })
    return true
  }
  res.writeHead(200, {
    'content-type': contentTypeOf(name),
    'cache-control': 'no-cache',
  })
  if (req.method === 'GET') res.end(body)
  else res.end()
  return true
}

/** 脱敏：移除/截断敏感字段。 */
function sanitizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase()
    if (lk === 'x-signature') { out[k] = '***'; continue }
    if (lk === 'cookie') { out[k] = '***'; continue }
    out[k] = v
  }
  return out
}

function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (k === 'publicKey' || k === 'privateKey') { out[k] = '***'; continue }
    if (k === 'prompt' && typeof v === 'string') { out[k] = v.length > 50 ? v.slice(0, 50) + '…' : v; continue }
    out[k] = v
  }
  return out
}

/** 完整处理器（注册为 /bizbridge 前缀路由）。 */
export function createBridgeHandler(runtime: BridgeRuntime) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = pathnameOf(req)
    const clientId = (req.headers['x-client-id'] as string) ?? '-'
    // 入口即记录（无论签名成败）
    runtime.fileLogger.info('http', `>>> ${req.method} ${pathname}`, { clientId })
    try {
      // 第一方参考/调试页面（GET/HEAD，免签名）
      if (serveStatic(runtime, req, res, pathname)) return
      // 回调测试接收端点（免签名：scheduler 服务端 POST，不携带签名头）
      if (pathname === '/bizbridge/api/v1/callback-test/receive' && req.method === 'POST') {
        const rawBody = await readBody(req)
        const body = parseJsonBody(rawBody)
        handleCallbackTestReceive(body, res)
        return
      }
      // 其余全部 POST + 签名
      if (req.method !== 'POST') {
        runtime.fileLogger.warn('http', `method not allowed: ${req.method}`, { pathname })
        writeJson(res, 404, { error: { code: 'NOT_FOUND', message: `route not found: ${req.method} ${pathname}`, details: {} } })
        return
      }
      const rawBody = await readBody(req)
      const caller = runtime.verifier.verify(req.headers, 'POST', pathname, rawBody, runtime.nonceSeen)
      const body = parseJsonBody(rawBody)
      runtime.fileLogger.info('http', `<<< ${req.method} ${pathname} OK`, { clientId: caller.clientId, scope: caller.scope })
      await dispatch(runtime, caller, pathname, body, res)
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      runtime.fileLogger.error('http', `<<< ${pathname} FAIL`, { clientId, error: msg })
      sendError(res, error)
    }
  }
}

/** 内部路由分发。 */
async function dispatch(
  runtime: BridgeRuntime,
  caller: { clientId: string; scope: Array<'stream' | 'callback' | 'admin'> },
  pathname: string,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const { db, fileLogger } = runtime
  if (pathname === '/bizbridge/api/v1/stream') {
    fileLogger.info('stream', `submit by ${caller.clientId}`, { sessionId: body.session_id, bizId: body.biz_id })
    await handleStreamSubmit(runtime, caller, body, res)
    return
  }
  if (pathname === '/bizbridge/api/v1/callback') {
    fileLogger.info('callback', `submit by ${caller.clientId}`, { sessionId: body.session_id, bizId: body.biz_id })
    enqueueCallback(runtime, caller, body, res)
    return
  }
  if (pathname === '/bizbridge/api/v1/tasks/list') {
    writeJson(res, 200, listOp(db, caller, body))
    return
  }
  if (pathname === '/bizbridge/api/v1/stats') {
    writeJson(res, 200, statsOp(db, caller))
    return
  }
  if (pathname === '/bizbridge/api/v1/models') {
    fileLogger.info('models', `query by ${caller.clientId}`)
    writeJson(res, 200, await modelsOp(runtime))
    return
  }
  // /bizbridge/api/v1/sessions/<id>/messages
  const sessionMatch = /^\/bizbridge\/api\/v1\/sessions\/([A-Za-z0-9:._-]{1,128})\/messages$/.exec(pathname)
  if (sessionMatch !== null) {
    const sessionId = sessionMatch[1] ?? ''
    fileLogger.info('session-messages', `query by ${caller.clientId}`, { sessionId })
    if (runtime.sessionQuery === undefined) {
      writeJson(res, 501, { error: { code: 'NOT_IMPLEMENTED', message: 'sessionQuery service is not available', details: {} } })
      return
    }
    writeJson(res, 200, await sessionMessagesOp(runtime.sessionQuery, sessionId, caller, body))
    return
  }
  // 回调测试：状态查询（需签名，admin scope）
  const cbTestMatch = /^\/bizbridge\/api\/v1\/callback-test\/([A-Za-z0-9_-]{1,128})$/.exec(pathname)
  if (cbTestMatch !== null) {
    handleCallbackTestStatus(cbTestMatch[1] ?? '', res)
    return
  }
  // /bizbridge/api/v1/tasks/<id>[/logs|cancel|replay|priority]
  const match = /^\/bizbridge\/api\/v1\/tasks\/([A-Za-z0-9_-]{1,128})(?:\/(logs|cancel|replay|priority))?$/.exec(pathname)
  if (match !== null) {
    const taskId = match[1] ?? ''
    const action = match[2]
    if (action === undefined) {
      writeJson(res, 200, detailOp(db, taskId, caller))
      return
    }
    if (action === 'logs') {
      writeJson(res, 200, logsOp(db, taskId, caller, body))
      return
    }
    if (action === 'replay') {
      fileLogger.info('replay', `task ${taskId} by ${caller.clientId}`)
      writeJson(res, 200, replayOp(db, taskId, caller))
      return
    }
    if (action === 'priority') {
      fileLogger.info('priority', `task ${taskId} by ${caller.clientId}`, { priority: body.priority })
      writeJson(res, 200, priorityOp(db, taskId, caller, body.priority))
      return
    }
    if (action === 'cancel') {
      // 需先读任务以取得 session（agent 取消用），再执行取消
      const task = db.getTask(taskId)
      if (task === undefined) throw new NotFoundError(`task "${taskId}" not found`)
      if (task.client_id !== caller.clientId && !caller.scope.includes('admin')) {
        throw new ForbiddenError(`task "${taskId}" belongs to another client`)
      }
      fileLogger.info('cancel', `task ${taskId} by ${caller.clientId}`, { sessionId: task.session_id, status: task.status })
      const result = cancelOp(db, taskId, caller)
      if (result.needAgentCancel) {
        const cancelled = runtime.hub.cancel(task.session_id, `admin cancelled task ${taskId}`)
        runtime.db.addLog(taskId, 'cancelled', `管理级取消：中止 live agent（${cancelled ? '已通知' : '无活动 turn'}）`, {}, nowIso())
        if (!cancelled) {
          // 处理中但 run 尚未注册（认领窗口）——由调度器执行前的状态复核兜底
          runtime.logger.warn(`cancel task ${taskId}: no active turn found; scheduler re-check guards execution`)
        }
      }
      writeJson(res, 200, result)
      return
    }
  }
  throw new NotFoundError(`route not found: ${pathname}`)
}

/** 查询可用模型列表：从 DSH LLM 运行时读取 provider → model → reasoning efforts。 */
async function modelsOp(runtime: BridgeRuntime): Promise<Record<string, unknown>> {
  const providers = runtime.llm.listProviders()
  const result: Array<Record<string, unknown>> = []
  for (const provider of providers) {
    let models: Array<Record<string, unknown>> = []
    try {
      const rawModels = await runtime.llm.listModels(provider.id)
      for (const m of rawModels) {
        const model: Record<string, unknown> = {
          id: m.id,
          name: m.name,
          description: m.description ?? null,
          inputModalities: m.inputModalities ?? null,
          reasoningEfforts: null,
          defaultMaxTokens: null,
        }
        // 尝试获取模型详情（reasoning efforts + maxTokens）
        try {
          const info = await runtime.llm.resolveModelInfo(provider.id, m.id)
          if (info.reasoning?.efforts) {
            model.reasoningEfforts = info.reasoning.efforts.map(e => ({
              id: e.id,
              name: e.name,
              description: e.description ?? null,
            }))
          }
          if (info.defaultMaxTokens !== undefined) {
            model.defaultMaxTokens = info.defaultMaxTokens
          }
        } catch { /* 单模型查询失败不影响整体 */ }
        models.push(model)
      }
    } catch {
      // adapter 不可用或查询失败，跳过该 provider 的模型
    }
    result.push({
      id: provider.id,
      name: provider.name,
      models,
    })
  }
  return { providers: result }
}

/** 回调响应入队（§3.2 / §6.4.2）：立即返回 task_id + queued。 */
function enqueueCallback(
  runtime: BridgeRuntime,
  caller: { clientId: string; scope: Array<'stream' | 'callback' | 'admin'> },
  body: Record<string, unknown>,
  res: ServerResponse,
): void {
  const input = validateSubmitInput(caller, 'callback', body)
  const sid = internalSessionId(input.clientId, input.sessionId, 'cb')
  const now = nowIso()
  const taskId = randomUUID()
  runtime.db.createTask({
    id: taskId,
    clientId: input.clientId,
    bizId: input.bizId,
    replaySeq: 0,
    sessionId: sid,
    prompt: input.prompt,
    type: 'callback',
    params: input.params,
    callbackUrl: input.callbackUrl,
    priority: input.priority ?? 0,
    scheduledAt: now,
    now,
  })
  runtime.db.addLog(taskId, 'received', '回调任务已入队', { biz_id: input.bizId, session_id: sid }, now)
  writeJson(res, 200, {
    task_id: taskId,
    status: 'queued',
    message: '任务已入队，等待处理',
    ext: {},
  })
}

// ─── 回调测试接收器（内存存储，仅用于调试页面端到端测试） ───

interface CallbackTestEntry {
  task_id: string
  biz_id: string
  status: string
  result: unknown
  received_at: string
  raw_body: unknown
}

const callbackTestStore = new Map<string, CallbackTestEntry>()
const CALLBACK_TEST_TTL_MS = 30 * 60 * 1000 // 30 分钟自动清理

/** 回调测试接收端点：scheduler POST 到此，存储到内存。 */
function handleCallbackTestReceive(body: unknown, res: ServerResponse): void {
  const entry = body as Record<string, unknown>
  const taskId = typeof entry.task_id === 'string' ? entry.task_id : 'unknown'
  const now = new Date().toISOString()
  callbackTestStore.set(taskId, {
    task_id: taskId,
    biz_id: typeof entry.biz_id === 'string' ? entry.biz_id : '',
    status: typeof entry.status === 'string' ? entry.status : 'unknown',
    result: entry.result ?? null,
    received_at: now,
    raw_body: body,
  })
  // 清理过期条目
  const cutoff = Date.now() - CALLBACK_TEST_TTL_MS
  for (const [id, e] of callbackTestStore) {
    if (new Date(e.received_at).getTime() < cutoff) callbackTestStore.delete(id)
  }
  writeJson(res, 200, { ok: true, task_id: taskId, received_at: now })
}

/** 回调测试状态查询：前端轮询此端点等待回调到达。 */
function handleCallbackTestStatus(taskId: string, res: ServerResponse): void {
  const entry = callbackTestStore.get(taskId)
  if (entry === undefined) {
    writeJson(res, 200, { task_id: taskId, received: false })
    return
  }
  writeJson(res, 200, { task_id: taskId, received: true, ...entry })
}
