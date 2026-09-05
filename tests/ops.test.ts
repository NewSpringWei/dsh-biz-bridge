/**
 * 管理/业务操作层测试（§6.5）：scope 越权、取消/重播/优先级规则、列表隔离、
 * 提交校验（wire id 格式 / callback_url / params 映射）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { BridgeDb, nowIso } from '../src/core/db.ts'
import {
  ForbiddenError, InvalidRequestError, NotFoundError, TaskRunningError,
} from '../src/shared/errors.ts'
import {
  cancelOp, detailOp, listOp, logsOp, priorityOp, replayOp, statsOp,
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

test('cancel: business cannot cancel processing; admin can with agent cancel flag', () => {
  const db = openDb()
  const id = makeCallback(db)
  db.claimSpecific(id, nowIso()) // processing
  assert.throws(() => cancelOp(db, id, BIZ), TaskRunningError)
  const adminResult = cancelOp(db, id, ADMIN)
  assert.equal(adminResult.needAgentCancel, true)
  assert.equal(db.getTask(id)?.status, 'cancelled')
})

test('cancel: not found', () => {
  const db = openDb()
  assert.throws(() => cancelOp(db, 'missing', ADMIN), NotFoundError)
})

// ---------- 重播（§6.5.5） ----------

test('replay: only callback, only non-pending, ownership', () => {
  const db = openDb()
  // queued 不允许重播
  const queuedId = makeCallback(db, { bizId: 'QUEUED-1' })
  assert.throws(() => replayOp(db, queuedId, BIZ), InvalidRequestError)
  // stream 不允许重播
  const streamId = makeCallback(db, { bizId: 'STREAM-1', type: 'stream' })
  db.markProcessing(streamId, nowIso())
  assert.throws(() => replayOp(db, streamId, ADMIN), InvalidRequestError)
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
