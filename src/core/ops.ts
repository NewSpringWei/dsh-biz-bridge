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
  DuplicateBizIdError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  TaskRunningError,
} from '../shared/errors.ts'
import { externalSessionId } from '../shared/session-id.ts'
import type { Caller } from './auth.ts'
import type { NewTaskInput, TaskRow, TaskStatus, TaskType } from '../shared/types.ts'
import type { SessionQueryLike } from '../shared/runtime.ts'

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
    session_id: externalSessionId(task.session_id),
    type: task.type,
    status: task.status,
    usage: parseUsage(task.usage),
    priority: task.priority,
    created_at: task.created_at,
    updated_at: task.updated_at,
  }
}

/** tasks.usage JSON 列 → 对象；NULL / 非对象 / 非法 JSON 一律按 null（列表与详情共用）。 */
function parseUsage(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** 任务详情（§6.5.2）。 */
export function detailOp(db: BridgeDb, taskId: string, caller: Caller): Record<string, unknown> {
  const task = requireTaskOwned(db, taskId, caller)
  const result = db.getTaskResult(taskId)
  return {
    task_id: task.id,
    client_id: task.client_id,
    biz_id: task.biz_id,
    replay_seq: task.replay_seq,
    session_id: externalSessionId(task.session_id),
    type: task.type,
    status: task.status,
    prompt: task.prompt,
    params: task.params === null ? null : JSON.parse(task.params),
    callback_url: task.callback_url,
    result,
    usage: parseUsage(task.usage),
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
 * 规则：终态 → 400；业务级仅可取消**自有**任务，管理级可跨 client；
 * 业务级可取消自己 queued/received/processing（含进行中任务，等同管理级语义，
 * 处理中任务会被中止 live agent）；越权 → 403。
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
  const changed = db.cancelTask(
    taskId,
    `任务被${isAdmin(caller) ? '管理级' : '业务级'}调用方取消`,
    nowIso(),
    ['queued', 'received', 'processing'],
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
  return { task_id: taskId, status: 'cancelled', needAgentCancel: task.status === 'processing' }
}

/**
 * 任务重播（§6.5.5）：仅回调任务；且原任务**已完成处理**（completed / failed /
 * callback_failed，无论执行成败）。新任务 replay_seq = 该 (client_id, biz_id) 当前
 * **最大 replay_seq + 1**（重播较旧条目不会撞唯一键/乱序），完全继承业务字段。
 */
export function replayOp(db: BridgeDb, taskId: string, caller: Caller): Record<string, unknown> {
  const task = requireTaskOwned(db, taskId, caller)
  if (task.type !== 'callback') {
    throw new InvalidRequestError(`task "${taskId}" is type ${task.type}; only callback tasks support replay`)
  }
  const replayable: readonly TaskStatus[] = ['completed', 'failed', 'callback_failed']
  if (!replayable.includes(task.status)) {
    throw new InvalidRequestError(`task "${taskId}" is ${task.status}; replay only applies to finished callback tasks (completed / failed / callback_failed)`)
  }
  const now = nowIso()
  const { client_id: clientId, biz_id: bizId } = task
  // 并发重播竞争：先算后插非原子，撞唯一键时重算最大 seq 再试（有限次）。
  for (let attempt = 0; attempt < 5; attempt++) {
    const nextSeq = db.maxReplaySeq(clientId, bizId) + 1
    try {
      const newId = randomUUID()
      db.createTask({
        id: newId,
        clientId,
        bizId,
        replaySeq: nextSeq,
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
        biz_id: bizId,
        replay_seq: nextSeq,
        status: 'queued',
        message: '任务已重播，新任务已入队',
      }
    } catch (error: unknown) {
      if (error instanceof DuplicateBizIdError) continue
      throw error
    }
  }
  throw new TaskRunningError(`task "${taskId}" replay collided repeatedly under concurrency; please retry`)
}

/**
 * 再次触发回调（§6.5.8）：已完成执行（completed，无论回调是否已送达）或送达
 * 耗尽（callback_failed）的回调任务，重新武装送达状态机并立即投递。
 * 仅回调任务；业务级仅可操作自有任务。
 */
export function redeliverOp(
  db: BridgeDb,
  taskId: string,
  caller: Caller,
): { task_id: string; status: 'completed'; callback_status: 'pending'; message: string } {
  const task = requireTaskOwned(db, taskId, caller)
  if (task.type !== 'callback') {
    throw new InvalidRequestError(`task "${taskId}" is type ${task.type}; only callback tasks support redelivery`)
  }
  if (task.status !== 'completed' && task.status !== 'callback_failed') {
    throw new InvalidRequestError(`task "${taskId}" is ${task.status}; redelivery only applies to completed / callback_failed callback tasks`)
  }
  if (task.callback_url === null) {
    throw new InvalidRequestError(`task "${taskId}" has no callback_url; cannot redeliver`)
  }
  const changed = db.armRedelivery(taskId, nowIso())
  if (changed === 0) {
    // 竞态：并发状态变化
    const fresh = db.getTask(taskId)
    const status = fresh?.status ?? 'gone'
    throw new TaskRunningError(`task "${taskId}" changed state concurrently (now ${status}); cannot redeliver`)
  }
  return {
    task_id: taskId,
    status: 'completed',
    callback_status: 'pending',
    message: '回调已重新武装，将在下一轮调度立即投递',
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

/**
 * DSH sessionQuery 用**稳定 code** 表达失败（`SessionQueryError`，码集合见 DSH
 * `session-query/src/config.ts`）。这里按 code 判定"会话不存在"，不匹配错误文案——
 * 文案随时可能改，code 才是契约。
 */
function isSessionNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: unknown }).code === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

/**
 * 读取会话快照。"会话不存在"属于**调用方输入问题**，必须映射为 404 `NOT_FOUND`，
 * 不能漏成 500（否则会污染 5xx 告警、被客户端当作可重试错误反复重试）。
 * 其余失败（持久化损坏、IO 故障）如实上抛 → 500，不掩盖真实的服务端问题。
 */
async function readSessionOr404(
  sessionQuery: SessionQueryLike,
  sessionId: string,
): Promise<Awaited<ReturnType<SessionQueryLike['readSession']>>> {
  try {
    return await sessionQuery.readSession(sessionId)
  } catch (error: unknown) {
    if (isSessionNotFoundError(error)) {
      throw new NotFoundError(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/**
 * 会话消息查询（按 session_id 投影对话内容）。
 * 从 DSH sessionQuery 服务读取完整事件流，过滤并转换为业务友好的消息格式。
 */
export async function sessionMessagesOp(
  sessionQuery: SessionQueryLike,
  sessionId: string,
  caller: Caller,
  body: Record<string, unknown>,
): Promise<{
  session_id: string
  total: number
  page: number
  page_size: number
  messages: Array<Record<string, unknown>>
}> {
  if (!isAdmin(caller)) {
    throw new ForbiddenError('scope "admin" is required for session message queries')
  }
  const { page, pageSize } = resolvePage(body.page, body.page_size)

  const snapshot = await readSessionOr404(sessionQuery, sessionId)
  const messages = projectMessages(snapshot.events)

  const total = messages.length
  const offset = (page - 1) * pageSize
  const paged = messages.slice(offset, offset + pageSize)

  return {
    session_id: sessionId,
    total,
    page,
    page_size: pageSize,
    messages: paged,
  }
}

/** 从 SessionEvent[] 投影出用户/助手消息列表。 */
function projectMessages(
  events: Array<{ type: string; data?: unknown; seq?: number }>,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = []
  for (const event of events) {
    if (event.type === 'user/message') {
      // DSH 0.1.5：`user/message` 事件的 data **就是 UserMessage 本身**，不是 `{ message }` 包装。
      // 对照 DSH `session/src/index.ts` 的取法：`type === 'user/message' ? record : record.message`。
      // 这里兼容两种形状（先探测 `.message`），避免宿主版本差异导致 user 消息被静默丢弃。
      const data = event.data as Record<string, unknown> | null | undefined
      const message = data != null && typeof data === 'object' && 'message' in data ? data.message : data
      const text = extractTextContent(message)
      if (text !== '') {
        messages.push({
          role: 'user',
          content: text,
          seq: event.seq ?? null,
          timestamp: (data as { time?: number } | null | undefined)?.time ?? null,
        })
      }
    } else if (event.type === 'assistant/message') {
      const data = (event.data ?? {}) as { message?: unknown; usage?: Record<string, unknown>; time?: number }
      const text = extractTextContent(data.message)
      if (text !== '') {
        messages.push({
          role: 'assistant',
          content: text,
          usage: data.usage ?? null,
          seq: event.seq ?? null,
          timestamp: data.time ?? null,
        })
      }
    }
  }
  return messages
}

/** 从消息 content 数组中提取纯文本。 */
function extractTextContent(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
      const value = (block as { text?: unknown }).text
      if (typeof value === 'string') text += value
    }
  }
  return text
}
