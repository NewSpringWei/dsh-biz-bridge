/**
 * 管理/业务操作层测试（§6.5）：scope 越权、取消/重播/优先级规则、列表隔离、
 * 提交校验（wire id 格式 / callback_url / params 映射）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { BridgeDb, nowIso } from '../src/core/db.ts'
import {
  ForbiddenError, InvalidRequestError, NotFoundError,
} from '../src/shared/errors.ts'
import {
  cancelOp, detailOp, listOp, logsOp, priorityOp, redeliverOp, replayOp, statsOp,
} from '../src/core/ops.ts'
import { validateSubmitInput } from '../src/core/submission.ts'
import type { Caller } from '../src/core/auth.ts'

function openDb(): BridgeDb {
  return new BridgeDb({ path: ':memory:', journalMode: 'WAL', busyTimeout: 2000 })
}

const BIZ: Caller = { clientId: 'biz-a', scope: ['stream', 'callback'] }
const ADMIN: Caller = { clientId: 'admin-1', scope: ['admin'] }
const OTHER: Caller = { clientId: 'biz-b', scope: ['callback'] }

function makeCallback(db: BridgeDb, overrides: Partial<{ clientId: string; bizId: string; sessionId: string; type: 'stream' | 'callback' }> = {}): string {
  const now = nowIso()
  const id = randomUUID()
  db.createTask({
    id,
    clientId: overrides.clientId ?? BIZ.clientId,
    bizId: overrides.bizId ?? 'REQ-1',
    replaySeq: 0,
    sessionId: overrides.sessionId ?? 'session-1',
    prompt: '请总结',
    type: overrides.type ?? 'callback',
    callbackUrl: overrides.type === 'stream' ? undefined : 'https://example.com/cb',
    priority: 0,
    scheduledAt: now,
    now,
  })
  db.addLog(id, 'received', '入队')
  return id
}

function complete(db: BridgeDb, taskId: string): void {
  db.claimSpecific(taskId, nowIso())
  db.completeTask(taskId, { result: '结果内容', isCallback: true, now: nowIso() })
}

// ---------- 提交校验（validateSubmitInput / §6.4） ----------

test('submit validation: scope, wire-id, params, callback_url', () => {
  const db = openDb()
  void db
  // scope 缺失 → 403
  assert.throws(() => validateSubmitInput({ clientId: 'x', scope: ['stream'] }, 'callback', { biz_id: 'R', session_id: 'S', prompt: 'p' }), ForbiddenError)
  // wire id 非法
  assert.throws(() => validateSubmitInput(BIZ, 'stream', { biz_id: 'bad/id', session_id: 'S', prompt: 'p' }), InvalidRequestError)
  assert.throws(() => validateSubmitInput(BIZ, 'stream', { biz_id: 'R', session_id: '中文会话', prompt: 'p' }), InvalidRequestError)
  // prompt 非字符串
  assert.throws(() => validateSubmitInput(BIZ, 'stream', { biz_id: 'R', session_id: 'S', prompt: 42 }), InvalidRequestError)
  // callback 缺 url / 非 http(s)
  assert.throws(() => validateSubmitInput(BIZ, 'callback', { biz_id: 'R', session_id: 'S', prompt: 'p' }), InvalidRequestError)
  assert.throws(() => validateSubmitInput(BIZ, 'callback', { biz_id: 'R', session_id: 'S', prompt: 'p', callback_url: 'ftp://x' }), InvalidRequestError)
  // params 非对象
  assert.throws(() => validateSubmitInput(BIZ, 'stream', { biz_id: 'R', session_id: 'S', prompt: 'p', params: 'x' }), InvalidRequestError)
  // params 映射值类型非法
  assert.throws(() => validateSubmitInput(BIZ, 'stream', { biz_id: 'R', session_id: 'S', prompt: 'p', params: { provider: 1 } }), InvalidRequestError)
  assert.throws(() => validateSubmitInput(BIZ, 'stream', { biz_id: 'R', session_id: 'S', prompt: 'p', params: { maxTokens: 0 } }), InvalidRequestError)
})

test('submit validation: valid inputs produce overrides and callback fields', () => {
  const stream = validateSubmitInput(BIZ, 'stream', {
    biz_id: 'REQ-9', session_id: 's-9', prompt: 'hi',
    params: { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 4096, tools: ['x'] },
  })
  assert.equal(stream.type, 'stream')
  assert.deepEqual(stream.agentOverrides, { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 4096 })
  assert.deepEqual(stream.params, { provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 4096, tools: ['x'] })
  const cb = validateSubmitInput(BIZ, 'callback', {
    biz_id: 'REQ-10', session_id: 's-10', prompt: 'hi', callback_url: 'https://host/cb', priority: 3,
  })
  assert.equal(cb.callbackUrl, 'https://host/cb')
  assert.equal(cb.priority, 3)
  assert.equal(cb.agentOverrides, undefined)
})

// ---------- 取消（§6.5.4） ----------

test('cancel: business cancels own queued; terminal returns 400; cross client 403', () => {
  const db = openDb()
  const id = makeCallback(db)
  const result = cancelOp(db, id, BIZ)
  assert.equal(result.status, 'cancelled')
  assert.equal(db.getTask(id)?.status, 'cancelled')
  assert.throws(() => cancelOp(db, id, BIZ), InvalidRequestError) // 终态
  const foreign = makeCallback(db, { clientId: OTHER.clientId })
  assert.throws(() => cancelOp(db, foreign, BIZ), ForbiddenError)
  // 管理级可取消任意 client
  assert.equal(cancelOp(db, foreign, ADMIN).status, 'cancelled')
})

test('cancel: business can cancel own processing; admin can cancel any client processing', () => {
  const db = openDb()
  const id = makeCallback(db)
  db.claimSpecific(id, nowIso()) // processing
  const bizResult = cancelOp(db, id, BIZ)
  assert.equal(bizResult.needAgentCancel, true) // 业务级取消处理中任务同样中止 live agent
  assert.equal(db.getTask(id)?.status, 'cancelled')
  // 管理级可跨 client 取消处理中任务
  const otherId = makeCallback(db, { clientId: OTHER.clientId })
  db.claimSpecific(otherId, nowIso())
  const adminResult = cancelOp(db, otherId, ADMIN)
  assert.equal(adminResult.needAgentCancel, true)
  assert.equal(db.getTask(otherId)?.status, 'cancelled')
})

test('cancel: not found', () => {
  const db = openDb()
  assert.throws(() => cancelOp(db, 'missing', ADMIN), NotFoundError)
})

// ---------- 重播（§6.5.5） ----------

test('replay: only finished callback tasks (not queued/stream/cancelled), ownership', () => {
  const db = openDb()
  // queued 不允许重播
  const queuedId = makeCallback(db, { bizId: 'QUEUED-1' })
  assert.throws(() => replayOp(db, queuedId, BIZ), InvalidRequestError)
  // stream 不允许重播
  const streamId = makeCallback(db, { bizId: 'STREAM-1', type: 'stream' })
  db.markProcessing(streamId, nowIso())
  assert.throws(() => replayOp(db, streamId, ADMIN), InvalidRequestError)
  // cancelled（未完成处理）不允许重播
  const cancelledId = makeCallback(db, { bizId: 'CANCEL-1' })
  db.cancelTask(cancelledId, '测试取消', nowIso())
  assert.equal(db.getTask(cancelledId)?.status, 'cancelled')
  assert.throws(() => replayOp(db, cancelledId, ADMIN), InvalidRequestError)
  // 他人任务 → 403
  const otherId = makeCallback(db, { clientId: OTHER.clientId, bizId: 'OTH-1' })
  complete(db, otherId)
  assert.throws(() => replayOp(db, otherId, BIZ), ForbiddenError)
  // 正常重播：继承字段 + replay_seq=1 + 同 (client,biz) 唯一
  const origin = makeCallback(db, { bizId: 'REPLAY-1' })
  complete(db, origin)
  const result = replayOp(db, origin, BIZ) as { task_id: string; biz_id: string; replay_seq: number; status: string }
  assert.equal(result.biz_id, 'REPLAY-1')
  assert.equal(result.replay_seq, 1)
  assert.equal(result.status, 'queued')
  const copy = db.getTask(result.task_id)
  assert.ok(copy)
  assert.equal(copy?.client_id, BIZ.clientId)
  assert.equal(copy?.session_id, 'session-1')
  assert.equal(copy?.prompt, '请总结')
  assert.equal(copy?.callback_url, 'https://example.com/cb')
  // 详情：全文 result 来自 task_results；usage 来自 tasks 列（未提供时 null）
  const originDetail = detailOp(db, origin, ADMIN) as { result: string | null; usage: unknown }
  assert.equal(originDetail.result, '结果内容')
  assert.equal(originDetail.usage, null)
})

test('replay numbers by max replay_seq of (client,biz), not the source row', () => {
  const db = openDb()
  const origin = makeCallback(db, { bizId: 'REPLAY-MAX' })
  complete(db, origin) // seq0 → completed
  const r1 = replayOp(db, origin, BIZ) as { task_id: string; replay_seq: number }
  assert.equal(r1.replay_seq, 1)
  // 再重播 seq0 行：应取 max(1)+1 = 2，而不是 0+1（旧行为会撞唯一键）
  const r2 = replayOp(db, origin, BIZ) as { task_id: string; replay_seq: number }
  assert.equal(r2.replay_seq, 2)
  // 重播最早的重播行（seq1 完成后再重播）应续到 3
  const seqOne = db.getTask(r1.task_id)
  assert.ok(seqOne)
  complete(db, seqOne.id)
  const r3 = replayOp(db, seqOne.id, BIZ) as { task_id: string; replay_seq: number }
  assert.equal(r3.replay_seq, 3)
  const all = db.listTasks({ bizId: 'REPLAY-MAX', page: 1, pageSize: 100 })
  assert.deepEqual(all.tasks.map(t => t.replay_seq).sort((a, b) => a - b), [0, 1, 2, 3])
})

// ---------- 再次触发回调（§6.5.8 redeliver） ----------

test('redeliver: completed / callback_failed callback tasks re-arm delivery', () => {
  const db = openDb()
  // completed + 送达已成功 → 可再次触发回调
  const doneId = makeCallback(db, { bizId: 'RD-1' })
  db.claimSpecific(doneId, nowIso())
  db.completeTask(doneId, { result: 'r1', usage: { total_tokens: 3 }, isCallback: true, now: nowIso() })
  db.recordCallbackResult(doneId, { ok: true, retryCount: 0, maxRetry: 3, retryIntervalSeconds: 30, now: nowIso() })
  assert.equal(db.getTask(doneId)?.callback_status, 'succeeded')
  const okResult = redeliverOp(db, doneId, BIZ) as { callback_status: string }
  assert.equal(okResult.callback_status, 'pending')
  assert.equal(db.getTask(doneId)?.status, 'completed')
  assert.equal(db.getDeliveryCandidate(nowIso())?.id, doneId)

  // callback_failed（送达耗尽）→ 复位为 completed + pending，可被重新投递
  const failedId = makeCallback(db, { bizId: 'RD-2' })
  db.claimSpecific(failedId, nowIso())
  db.completeTask(failedId, { result: 'r2', isCallback: true, now: nowIso() })
  for (let a = 1; a <= 3; a++) db.recordCallbackResult(failedId, { ok: false, retryCount: a, maxRetry: 3, retryIntervalSeconds: 30, now: nowIso() })
  db.recordCallbackResult(failedId, { ok: false, retryCount: 4, maxRetry: 3, retryIntervalSeconds: 30, now: nowIso() })
  assert.equal(db.getTask(failedId)?.status, 'callback_failed')
  redeliverOp(db, failedId, BIZ)
  const rearmed = db.getTask(failedId)
  assert.equal(rearmed?.status, 'completed')
  assert.equal(rearmed?.callback_status, 'pending')
  assert.equal(rearmed?.retry_count, 0)
})

test('redeliver: wrong type / wrong status / cross-client rejected', () => {
  const db = openDb()
  // stream 任务不可 redeliver
  const streamId = makeCallback(db, { bizId: 'RD-S1', type: 'stream' })
  db.markProcessing(streamId, nowIso())
  assert.throws(() => redeliverOp(db, streamId, ADMIN), InvalidRequestError)
  // 未开始（queued）回调不可 redeliver
  const queuedId = makeCallback(db, { bizId: 'RD-Q1' })
  assert.throws(() => redeliverOp(db, queuedId, ADMIN), InvalidRequestError)
  // 越权：他人已完成任务 → 403
  const otherId = makeCallback(db, { clientId: OTHER.clientId, bizId: 'RD-O1' })
  db.claimSpecific(otherId, nowIso())
  db.completeTask(otherId, { result: 'x', isCallback: true, now: nowIso() })
  assert.throws(() => redeliverOp(db, otherId, BIZ), ForbiddenError)
  // 本人可
  assert.equal((redeliverOp(db, otherId, ADMIN) as { callback_status: string }).callback_status, 'pending')
})

// ---------- 优先级（§6.5.6） ----------

test('priority: only queued, integer, ownership', () => {
  const db = openDb()
  const queuedId = makeCallback(db)
  assert.equal(priorityOp(db, queuedId, BIZ, 5).priority, 5)
  assert.equal(db.getTask(queuedId)?.priority, 5)
  assert.throws(() => priorityOp(db, queuedId, BIZ, 'high'), InvalidRequestError)
  const otherId = makeCallback(db, { clientId: OTHER.clientId })
  assert.throws(() => priorityOp(db, otherId, BIZ, 1), ForbiddenError)
  const doneId = makeCallback(db, { bizId: 'DONE-1' })
  complete(db, doneId)
  assert.throws(() => priorityOp(db, doneId, ADMIN, 1), InvalidRequestError)
})

// ---------- 列表 / 详情 / 日志 / 统计 scope ----------

test('list/detail/logs/stats ownership isolation', () => {
  const db = openDb()
  makeCallback(db, { clientId: BIZ.clientId, bizId: 'BIZ-1', sessionId: 'sess-a' })
  makeCallback(db, { clientId: OTHER.clientId, bizId: 'OTH-1', sessionId: 'sess-b' })
  db.addLog('does-not-exist-ignore', 'received', 'x') // 无效但无害

  // 业务级列表只含自身
  const bizList = listOp(db, BIZ, { page: 1, page_size: 10 }) as { total: number; tasks: Array<{ client_id: string }> }
  assert.equal(bizList.total, 1)
  assert.equal(bizList.tasks[0]?.client_id, BIZ.clientId)
  // 管理级可跨 client 并按 client_id 过滤
  const adminList = listOp(db, ADMIN, { page: 1, page_size: 10, client_id: OTHER.clientId }) as { total: number }
  assert.equal(adminList.total, 1)
  // 详情/日志越权
  const otherTask = db.listTasks({ clientId: OTHER.clientId, page: 1, pageSize: 10 }).tasks[0]
  assert.ok(otherTask)
  assert.throws(() => detailOp(db, otherTask.id, BIZ), ForbiddenError)
  assert.throws(() => logsOp(db, otherTask.id, BIZ, {}), ForbiddenError)
  assert.throws(() => detailOp(db, 'nope', ADMIN), NotFoundError)
  // admin 可见
  assert.equal((detailOp(db, otherTask.id, ADMIN) as { client_id: string }).client_id, OTHER.clientId)
  // 日志分页响应
  const logs = logsOp(db, otherTask.id, ADMIN, { page: 1, page_size: 10 }) as { total: number; logs: unknown[] }
  assert.equal(logs.total, 1)
  // 业务级统计限定自身
  const bizStats = statsOp(db, BIZ) as { tasks: { callback: { total: number } } }
  assert.equal(bizStats.tasks.callback.total, 0) // BIZ 的任务都是 queued（无终态）
  const adminStats = statsOp(db, ADMIN) as { queue: { queued: number } }
  assert.equal(adminStats.queue.queued, 2)
})
