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
 *   GET  …/static/*                第一方参考/调试页面（index/admin/client/utils，免签名）
 *
 * 除静态页外均需签名头（§6.2）。路由 handler 拥有完整响应生命周期（§6.1）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { ForbiddenError, NotFoundError } from '../shared/errors.ts'
import { parseJsonBody, readBody, sendError, writeJson } from './http-util.ts'
import {
  cancelOp, detailOp, listOp, logsOp, priorityOp, replayOp, statsOp,
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
  res.writeHead(200, { 'content-type': contentTypeOf(name) })
  if (req.method === 'GET') res.end(body)
  else res.end()
  return true
}

/** 完整处理器（注册为 /bizbridge 前缀路由）。 */
export function createBridgeHandler(runtime: BridgeRuntime) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = pathnameOf(req)
    try {
      // 第一方参考/调试页面（GET/HEAD，免签名）
      if (serveStatic(runtime, req, res, pathname)) return
      // 其余全部 POST + 签名
      if (req.method !== 'POST') {
        writeJson(res, 404, { error: { code: 'NOT_FOUND', message: `route not found: ${req.method} ${pathname}`, details: {} } })
        return
      }
      const rawBody = await readBody(req)
      const caller = runtime.verifier.verify(req.headers, 'POST', pathname, rawBody, runtime.nonceSeen)
      const body = parseJsonBody(rawBody)
      await dispatch(runtime, caller, pathname, body, res)
    } catch (error: unknown) {
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
  const { db } = runtime
  if (pathname === '/bizbridge/api/v1/stream') {
    await handleStreamSubmit(runtime, caller, body, res)
    return
  }
  if (pathname === '/bizbridge/api/v1/callback') {
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
      writeJson(res, 200, replayOp(db, taskId, caller))
      return
    }
    if (action === 'priority') {
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

/** 回调响应入队（§3.2 / §6.4.2）：立即返回 task_id + queued。 */
function enqueueCallback(
  runtime: BridgeRuntime,
  caller: { clientId: string; scope: Array<'stream' | 'callback' | 'admin'> },
  body: Record<string, unknown>,
  res: ServerResponse,
): void {
  const input = validateSubmitInput(caller, 'callback', body)
  const now = nowIso()
  const taskId = randomUUID()
  runtime.db.createTask({
    id: taskId,
    clientId: input.clientId,
    bizId: input.bizId,
    replaySeq: 0,
    sessionId: input.sessionId,
    prompt: input.prompt,
    type: 'callback',
    params: input.params,
    callbackUrl: input.callbackUrl,
    priority: input.priority ?? 0,
    scheduledAt: now,
    now,
  })
  runtime.db.addLog(taskId, 'received', '回调任务已入队', { biz_id: input.bizId, session_id: input.sessionId }, now)
  writeJson(res, 200, {
    task_id: taskId,
    status: 'queued',
    message: '任务已入队，等待处理',
    ext: {},
  })
}
