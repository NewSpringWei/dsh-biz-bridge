/**
 * 管理/业务操作层（§6.5）与提交校验——全部为纯函数：输入 db + 调用者，
 * 输出结果或抛 BizError。HTTP 层只做序列化。
 *
 * 越权口径（§6.2.5）：业务级 client 只能操作自身 client_id 数据，跨 client
 * 一律 403；admin 可跨 client。任务不存在返回 404。
 */

import { randomUUID } from 'node:crypto'
import { BridgeDb, assertWireId, normalizeTimeFilter, nowIso, resolvePage } from './db.ts'
import {
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  TaskRunningError,
} from '../shared/errors.ts'
import type { Caller } from './auth.ts'
import type { NewTaskInput, TaskRow, TaskStatus, TaskType } from '../shared/types.ts'

export function isAdmin(caller: Caller): boolean {
  return caller.scope.includes('admin')
}

/** 要求某 scope，否则 403（§6.5）。 */
export function requireScope(caller: Caller, scope: 'admin'): void {
  if (!isAdmin(caller)) throw new ForbiddenError(`scope "admin" is required for this operation`)
}

function assertTaskType(value: unknown, name = 'type'): TaskType {
  if (value !== 'stream' && value !== 'callback') {
    throw new InvalidRequestError(`${name} must be "stream" or "callback"`)
  }
  return value
}

function assertStatusFilter(value: unknown): TaskStatus | undefined {
  if (value === undefined || value === null) return undefined
  const allowed: readonly TaskStatus[] = [
    'queued', 'received', 'processing', 'completed', 'failed', 'callback_failed', 'cancelled',
  ]
  if (typeof value !== 'string' || !allowed.includes(value as TaskStatus)) {
    throw new InvalidRequestError('status filter is invalid')
  }
  return value as TaskStatus
}

/** 读取任务 + 归属守卫（业务级越权 403；不存在 404）。 */
export function requireTaskOwned(db: BridgeDb, taskId: string, caller: Caller) {
  const task = db.getTask(taskId)
  if (task === undefined) throw new NotFoundError(`task "${taskId}" not found`)
  if (!isAdmin(caller) && task.client_id !== caller.clientId) {
    throw new ForbiddenError(`task "${taskId}" belongs to another client`)
  }
  return task
}

/**
 * 流式/回调提交体校验 → NewTaskInput（§6.4）。
 * scope 守卫：stream 任务需 stream scope，callback 任务需 callback scope。
 */
export function validateSubmit(
  caller: Caller,
  type: TaskType,
  body: Record<string, unknown>,
): NewTaskInput {
  const scope: 'stream' | 'callback' = type
  if (!caller.scope.includes(scope)) {
    throw new ForbiddenError(`client "${caller.clientId}" lacks scope "${scope}"`)
  }
  const bizId = body.biz_id
  const sessionId = body.session_id
  const prompt = body.prompt
  if (typeof bizId !== 'string') throw new InvalidRequestError('biz_id must be a string')
  assertWireId(bizId, 'biz_id')
  if (typeof sessionId !== 'string') throw new InvalidRequestError('session_id must be a string')
  assertWireId(sessionId, 'session_id')
  if (typeof prompt !== 'string') throw new InvalidRequestError('prompt must be a string')
  const params = body.params
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
    throw new InvalidRequestError('params must be a JSON object')
  }
  const input: NewTaskInput = {
    clientId: caller.clientId,
    bizId,
    sessionId,
    prompt,
    type,
    params: params === undefined ? undefined : params as Record<string, unknown>,
  }
  if (type === 'callback') {
    const url = body.callback_url
    if (typeof url !== 'string' || !isHttpUrl(url)) {
      throw new InvalidRequestError('callback_url must be an absolute http(s) URL')
    }
    input.callbackUrl = url
  }
  const priority = body.priority
  if (priority !== undefined) {
    if (typeof priority !== 'number' || !Number.isSafeInteger(priority)) {
      throw new InvalidRequestError('priority must be an integer')
    }
    input.priority = priority
  }
  return input
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 任务列表（§6.5.1）：业务级自动追加 client_id = 调用者过滤。 */
export function listOp(
  db: BridgeDb,
  caller: Caller,
  body: Record<string, unknown>,
): { total: number; page: number; page_size: number; tasks: unknown[] } {
  const { page, pageSize } = resolvePage(body.page, body.page_size)
  const admin = isAdmin(caller)
  let clientId: string | undefined
  if (admin && body.client_id !== undefined) {
    if (typeof body.client_id !== 'string') throw new InvalidRequestError('client_id must be a string')
    clientId = body.client_id
  } else if (!admin) {
    clientId = caller.clientId
  }
  const start = body.start_time
  const end = body.end_time
  const result = db.listTasks({
    status: assertStatusFilter(body.status),
    type: body.type === undefined ? undefined : assertTaskType(body.type),
    clientId,
    bizId: body.biz_id === undefined ? undefined : String(body.biz_id),
    startTime: start === undefined ? undefined : normalizeTimeFilter(String(start), 'start_time'),
    endTime: end === undefined ? undefined : normalizeTimeFilter(String(end), 'end_time'),
    page,
    pageSize,
  })
  return {
    total: result.total,
    page,
    page_size: pageSize,
    tasks: result.tasks.map(task => summarize(task)),
  }
}

/** 列表行摘要（§6.5.1 响应字段）。 */
function summarize(task: TaskRow): Record<string, unknown> {
  return {
    task_id: task.id,
    client_id: task.client_id,
    biz_id: task.biz_id,
    replay_seq: task.replay_seq,
    session_id: task.session_id,
    type: task.type,
    status: task.status,
    priority: task.priority,
    created_at: task.created_at,
    updated_at: task.updated_at,
  }
}

/** 任务详情（§6.5.2）。 */
export function detailOp(db: BridgeDb, taskId: string, caller: Caller): Record<string, unknown> {
  const task = requireTaskOwned(db, taskId, caller)
  return {
    task_id: task.id,
    client_id: task.client_id,
    biz_id: task.biz_id,
    replay_seq: task.replay_seq,
    session_id: task.session_id,
    type: task.type,
    status: task.status,
    prompt: task.prompt,
    params: task.params === null ? null : JSON.parse(task.params),
    callback_url: task.callback_url,
    result: task.result,
    error_message: task.error_message,
    retry_count: task.retry_count,
    priority: task.priority,
    created_at: task.created_at,
    updated_at: task.updated_at,
    completed_at: task.completed_at,
  }
}

/** 任务日志（§6.5.3）。 */
export function logsOp(
  db: BridgeDb,
  taskId: string,
  caller: Caller,
  body: Record<string, unknown>,
): { total: number; page: number; page_size: number; logs: unknown[] } {
  requireTaskOwned(db, taskId, caller)
  const { page, pageSize } = resolvePage(body.page, body.page_size)
  const result = db.listLogs(taskId, page, pageSize)
  return {
    total: result.total,
    page,
    page_size: pageSize,
    logs: result.logs.map(log => ({
      id: log.id,
      stage: log.stage,
      message: log.message,
      metadata: log.metadata === null ? null : JSON.parse(log.metadata),
      created_at: log.created_at,
    })),
  }
}

/**
 * 任务取消（§6.5.4）。
 * 规则：终态 → 400；业务级仅可取消自身 queued/received（processing → 409，
 * 越权 → 403）；admin 可取消任意非终态（含 processing）。
 * @returns { taskId, status, cancelled, needAgentCancel }
 */
export function cancelOp(
  db: BridgeDb,
  taskId: string,
  caller: Caller,
): { task_id: string; status: 'cancelled'; needAgentCancel: boolean } {
  const task = requireTaskOwned(db, taskId, caller)
  const terminal: readonly TaskStatus[] = ['completed', 'failed', 'callback_failed', 'cancelled']
  if (terminal.includes(task.status)) {
    throw new InvalidRequestError(`task "${taskId}" is terminal (${task.status}), cannot be cancelled`)
  }
  const admin = isAdmin(caller)
  if (!admin && task.status === 'processing') {
    throw new TaskRunningError(`task "${taskId}" is already processing, cannot be cancelled by a business client`)
  }
  const changed = db.cancelTask(
    taskId,
    `任务被${admin ? '管理级' : '业务级'}调用方取消`,
    nowIso(),
    admin ? ['queued', 'received', 'processing'] : [task.status],
  )
  if (changed === 0) {
    // 竞态：被调度器抢占或并发取消
    const fresh = db.getTask(taskId)
    const status = fresh?.status
    if (status === undefined) throw new NotFoundError(`task "${taskId}" not found`)
    if (terminal.includes(status)) {
      throw new InvalidRequestError(`task "${taskId}" is already ${status}`)
    }
    throw new TaskRunningError(`task "${taskId}" already started (now ${status}); cannot be cancelled`)
  }
  return { task_id: taskId, status: 'cancelled', needAgentCancel: !admin ? false : task.status === 'processing' }
}

/**
 * 任务重播（§6.5.5）：仅回调任务；原任务非 queued/received 状态；新任务
 * replay_seq = 原 + 1，完全继承业务字段。
 */
export function replayOp(db: BridgeDb, taskId: string, caller: Caller): Record<string, unknown> {
  const task = requireTaskOwned(db, taskId, caller)
  if (task.type !== 'callback') {
    throw new InvalidRequestError(`task "${taskId}" is type ${task.type}; only callback tasks support replay`)
  }
  if (task.status === 'queued' || task.status === 'received') {
    throw new InvalidRequestError(`task "${taskId}" is ${task.status}; only non-pending tasks can be replayed`)
  }
  const now = nowIso()
  const newId = randomUUID()
  db.createTask({
    id: newId,
    clientId: task.client_id,
    bizId: task.biz_id,
    replaySeq: task.replay_seq + 1,
    sessionId: task.session_id,
    prompt: task.prompt,
    type: 'callback',
    params: task.params === null ? undefined : JSON.parse(task.params),
    callbackUrl: task.callback_url ?? undefined,
    priority: 0,
    scheduledAt: now,
    now,
  })
  return {
    task_id: newId,
    biz_id: task.biz_id,
    replay_seq: task.replay_seq + 1,
    status: 'queued',
    message: '任务已重播，新任务已入队',
  }
}

/** 优先级调整（§6.5.6）：仅 queued 状态。 */
export function priorityOp(db: BridgeDb, taskId: string, caller: Caller, priority: unknown): Record<string, unknown> {
  const task = requireTaskOwned(db, taskId, caller)
  if (typeof priority !== 'number' || !Number.isSafeInteger(priority)) {
    throw new InvalidRequestError('priority must be an integer')
  }
  if (task.status !== 'queued') {
    throw new InvalidRequestError(`task "${taskId}" is ${task.status}; priority only applies to queued tasks`)
  }
  const changed = db.updatePriority(taskId, priority)
  if (changed === 0) {
    throw new InvalidRequestError(`task "${taskId}" changed state concurrently; only queued tasks accept priority changes`)
  }
  return { task_id: taskId, priority, message: '优先级已调整' }
}

/** 运行统计（§6.5.7）。 */
export function statsOp(db: BridgeDb, caller: Caller): Record<string, unknown> {
  const admin = isAdmin(caller)
  const s = db.stats({ isAdmin: admin, clientId: caller.clientId })
  const rate = (success: number, failed: number): number => {
    const total = success + failed
    return total === 0 ? 0 : Number((success / total).toFixed(4))
  }
  return {
    system: { status: 'ok', version: '0.1.0', uptime: Math.floor(process.uptime()) },
    tasks: {
      stream: {
        total: s.tasks.stream.total,
        success: s.tasks.stream.success,
        failed: s.tasks.stream.failed,
        success_rate: rate(s.tasks.stream.success, s.tasks.stream.failed),
      },
      callback: {
        total: s.tasks.callback.total,
        success: s.tasks.callback.success,
        failed: s.tasks.callback.failed,
        success_rate: rate(s.tasks.callback.success, s.tasks.callback.failed),
      },
    },
    queue: { queued: s.queue.queued, processing: s.queue.processing },
    callback: { callback_failed: s.callback.callback_failed, avg_retry_count: Number(s.callback.avg_retry_count.toFixed(2)) },
  }
}
