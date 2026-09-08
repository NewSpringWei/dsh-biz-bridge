/**
 * 流式响应任务执行（§3.1 / §6.4.1）。
 *
 * 流程：验签/校验 → createTask(received) → openAgent → markProcessing →
 * SSE start → followup + whenIdle（期间 session/event 经 hub 转 SSE chunk）
 * → 归约结局落库 → SSE done/error。
 *
 * 断连即取消（§3.1）：res 'close' 且未收尾 → db 置 cancelled +
 * hub.cancel(agent.cancel)，agent 中止后按 cancelled 收尾，不写回调。
 *
 * 入库后失败兜底（§3.1/§9）：openAgent 抛 SessionBusy → cancelled（409）；
 * 其余执行性错误 → failed（500）；均以终态落库 + task_logs + 响应携带 task_id。
 */

import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { BizError, SessionBusyError } from '../shared/errors.ts'
import { beginSse, endSse, sendError, sseData, ssePing, writeJson } from './http-util.ts'
import type { BridgeRuntime } from '../shared/runtime.ts'
import type { Caller } from '../core/auth.ts'
import { nowIso } from '../core/db.ts'
import { validateSubmitInput } from '../core/submission.ts'
import { internalSessionId } from '../shared/session-id.ts'
import type { TaskRow } from '../shared/types.ts'

const SSE_KEEPALIVE_MS = 15_000

/** 提交前的会话忙预检（§5.8 流式 409）。 */
function busyPrecheck(runtime: BridgeRuntime, sessionId: string): string | undefined {
  if (runtime.hub.isBusy(sessionId) || runtime.pool.isBusy(sessionId)) {
    return `session "${sessionId}" already has a running task`
  }
  return undefined
}

/** 执行前失败以终态落库（§3.1 入库后失败兜底）。 */
function finalizePreExecutionFailure(
  runtime: BridgeRuntime,
  row: TaskRow,
  kind: 'cancelled' | 'failed',
  message: string,
): void {
  const now = nowIso()
  if (kind === 'cancelled') {
    runtime.db.cancelTask(row.id, message, now, ['processing', 'received'])
    runtime.db.addLog(row.id, 'cancelled', message, { reason: 'pre-execution' }, now)
    runtime.logger.info(`stream task ${row.id} cancelled before execution: ${message}`)
  } else {
    runtime.db.failTask(row.id, message, now)
    runtime.db.addLog(row.id, 'failed', message, { reason: 'pre-execution' }, now)
    runtime.logger.warn(`stream task ${row.id} failed before execution: ${message}`)
  }
}

/**
 * 流式响应主处理器（已验签 + body 解析完成）。
 * 成功 → SSE；SSE 前置失败 → 统一 JSON 错误（携带 task_id）。
 */
export async function handleStreamSubmit(
  runtime: BridgeRuntime,
  caller: Caller,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<void> {
  const { db } = runtime
  // 1. 校验 + 会话忙预检 → 409（不入库；同 session 已有进行中任务，§5.8）
  const input = validateSubmitInput(caller, 'stream', body)
  const sid = internalSessionId(input.clientId, input.sessionId, 'stream')
  const busy = busyPrecheck(runtime, sid)
  if (busy !== undefined) {
    runtime.fileLogger.warn('stream', `session busy: ${busy}`, { sessionId: sid })
    sendError(res, new SessionBusyError(busy))
    return
  }
  // 2. 入库 received + 日志
  const now = nowIso()
  const taskId = randomUUID()
  const row = db.createTask({
    id: taskId,
    clientId: input.clientId,
    bizId: input.bizId,
    replaySeq: 0,
    sessionId: sid,
    prompt: input.prompt,
    type: 'stream',
    params: input.params,
    priority: 0,
    scheduledAt: now,
    now,
  })
  db.addLog(taskId, 'received', '流式任务已接收', { biz_id: input.bizId, session_id: sid }, now)
  runtime.fileLogger.info('stream', `task ${taskId} created`, { bizId: input.bizId, sessionId: sid, clientId: input.clientId })

  // 3. openAgent（§5.2.1）；失败按“入库后失败兜底”落终态
  let agent
  try {
    agent = await runtime.pool.openAgent(sid, input.agentOverrides)
    runtime.fileLogger.info('stream', `task ${taskId} agent opened`, { sessionId: sid })
  } catch (error: unknown) {
    if (error instanceof SessionBusyError) {
      finalizePreExecutionFailure(runtime, row, 'cancelled', `会话忙，任务放弃：${error.message}`)
      sendError(res, error)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    finalizePreExecutionFailure(runtime, row, 'failed', `打开会话失败：${message}`)
    if (error instanceof BizError) {
      sendError(res, error)
    } else {
      writeJson(res, 500, {
        error: { code: 'INTERNAL', message: `openAgent 失败：${message}`, details: { task_id: taskId } },
      })
    }
    return
  }

  // 4. received → processing（SSE 转发前置，§3.1）；期间被取消则不再开始
  const progressed = db.markProcessing(taskId, nowIso())
  if (!progressed) {
    writeJson(res, 400, {
      error: { code: 'INVALID_REQUEST', message: '任务在开始前已被取消', details: { task_id: taskId } },
    })
    return
  }
  db.addLog(taskId, 'processing', '开始执行（会话决策：复用/resume/create）', {}, nowIso())

  // 5. SSE 通道（断连即取消）
  beginSse(res)
  runtime.fileLogger.info('stream', `task ${taskId} SSE started`)
  let settled = false
  let clientGone = false
  let keepalive: ReturnType<typeof setInterval> | undefined

  const stop = (): void => {
    if (keepalive !== undefined) {
      clearInterval(keepalive)
      keepalive = undefined
    }
    endSse(res)
  }
  res.on('close', () => {
    clientGone = true
    if (settled) return
    const message = '客户端断开连接，任务已取消'
    const cancelled = db.cancelTask(taskId, message, nowIso(), ['processing'])
    if (cancelled > 0) db.addLog(taskId, 'cancelled', message, { reason: 'disconnect' })
    runtime.hub.cancel(sid, 'client disconnected')
    runtime.logger.info(`stream task ${taskId} cancelled on client disconnect`)
  })

  sseData(res, { event: 'start', task_id: taskId })
  keepalive = setInterval(() => ssePing(res), SSE_KEEPALIVE_MS)

  // 6. 驱动 turn：session/event → SSE chunk 实时转发；每 assistant/message 落一条日志
  const outcome = await runtime.hub.runTurn({
    sessionId: sid,
    taskId,
    prompt: input.prompt,
    agent,
    messageFactory: runtime.messageFactory,
    onTextDelta: (text: string) => {
      sseData(res, { event: 'chunk', content: text })
    },
    onReasoningDelta: (text: string) => {
      sseData(res, { event: 'reasoning', content: text })
    },
    onAssistantMessage: (turn: number, text: string, usage: Record<string, unknown> | null) => {
      db.addLog(taskId, 'chunk', text, { turn, usage: usage ?? undefined })
    },
  })
  settled = true

  // 7. 按结局落库（终态由 SQL WHERE status 守卫，不覆盖并发取消）+ SSE 终帧
  const endTime = nowIso()
  if (outcome.kind === 'completed') {
    db.completeTask(taskId, { result: outcome.result, usage: outcome.usage, isCallback: false, now: endTime })
    db.addLog(taskId, 'completed', '任务完成', { usage: outcome.usage ?? undefined }, endTime)
    runtime.fileLogger.info('stream', `task ${taskId} completed`, { usage: outcome.usage ?? undefined })
    if (!clientGone) sseData(res, { event: 'done', task_id: taskId, usage: outcome.usage ?? null })
  } else if (outcome.kind === 'failed') {
    db.failTask(taskId, outcome.message, endTime)
    db.addLog(taskId, 'failed', outcome.message, { reason: outcome.reason }, endTime)
    runtime.fileLogger.error('stream', `task ${taskId} failed: ${outcome.message}`)
    if (!clientGone) {
      sseData(res, { event: 'error', task_id: taskId, reason: outcome.reason ?? { kind: 'error', message: outcome.message } })
    }
  } else {
    db.cancelTask(taskId, outcome.message, endTime, ['processing'])
    db.addLog(taskId, 'cancelled', outcome.message, {}, endTime)
    runtime.fileLogger.info('stream', `task ${taskId} cancelled: ${outcome.message}`)
    if (!clientGone) {
      sseData(res, { event: 'error', task_id: taskId, reason: { kind: 'aborted', message: outcome.message } })
    }
  }
  stop()
}
