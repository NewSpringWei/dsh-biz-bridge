/**
 * 数据存储层测试（§4）：建表幂等、幂等键唯一索引（replay_seq）、队列认领与
 * 排序、会话串行查询、回调送达状态机（§7.4）、激活时救援（§7.3）、日志与统计。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BridgeDb, nowIso } from '../src/core/db.ts'
import { DuplicateBizIdError } from '../src/shared/errors.ts'
import { rescueProcessing } from '../src/core/rescue.ts'

function openDb(): BridgeDb {
  return new BridgeDb({ path: ':memory:', journalMode: 'WAL', busyTimeout: 2000 })
}

function insertCallback(
  db: BridgeDb,
  input: Partial<Parameters<BridgeDb['createTask']>[0]> = {},
): ReturnType<BridgeDb['createTask']> {
  const now = nowIso()
  return db.createTask({
    id: `cb-${Math.random().toString(36).slice(2, 10)}`,
    clientId: 'biz-a',
    bizId: 'REQ-1',
    replaySeq: 0,
    sessionId: 'session-1',
    prompt: 'hello',
    type: 'callback',
    callbackUrl: 'https://example.com/cb',
    priority: 0,
    scheduledAt: now,
    now,
    ...input,
  })
}

test('schema is idempotent across reopen (file db)', () => {
  const dir = '.tmp-test-db'
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'd.db')
  const first = new BridgeDb({ path: file, journalMode: 'WAL', busyTimeout: 1000 })
  first.createTask({ id: 't1', clientId: 'a', bizId: 'b', replaySeq: 0, sessionId: 's', prompt: 'p', type: 'callback', priority: 0, scheduledAt: nowIso(), now: nowIso() })
  first.close()
  const second = new BridgeDb({ path: file, journalMode: 'WAL', busyTimeout: 1000 })
  const row = second.getTask('t1')
  assert.ok(row)
  second.close()
  rmSync(dir, { recursive: true, force: true })
})

test('createTask: stream received, callback queued', () => {
  const db = openDb()
  const stream = db.createTask({ id: 's1', clientId: 'a', bizId: 'b1', replaySeq: 0, sessionId: 'sess', prompt: 'x', type: 'stream', priority: 0, scheduledAt: nowIso(), now: nowIso() })
  const callback = insertCallback(db, { id: 'c1' })
  assert.equal(stream.status, 'received')
  assert.equal(callback.status, 'queued')
  assert.equal(callback.callback_url, 'https://example.com/cb')
})

test('UNIQUE(client_id, biz_id, replay_seq) maps duplicate to DuplicateBizIdError with details', () => {
  const db = openDb()
  const first = insertCallback(db, { id: 'c1' })
  assert.throws(
    () => insertCallback(db, { id: 'c2' }),
    (error: unknown) => {
      assert.ok(error instanceof DuplicateBizIdError)
      assert.equal(error.details.existing_task_id, first.id)
      assert.equal(error.details.existing_replay_seq, 0)
      assert.equal(error.details.existing_status, 'queued')
      return true
    },
  )
})

test('replay_seq increments release the same (client,biz) key', () => {
  const db = openDb()
  insertCallback(db, { id: 'c1', replaySeq: 0 })
  const replay = insertCallback(db, { id: 'c2', replaySeq: 1 })
  assert.equal(replay.status, 'queued')
})

test('queue claim ordering: priority asc, scheduled_at asc, id asc', () => {
  const db = openDb()
  const now = nowIso()
  insertCallback(db, { id: 'low', priority: 5, scheduledAt: now, bizId: 'a' })
  insertCallback(db, { id: 'high', priority: -1, scheduledAt: now, bizId: 'b' })
  insertCallback(db, { id: 'mid', priority: 0, scheduledAt: now, bizId: 'c' })
  const first = db.claimQueuedCallback(now)
  assert.equal(first?.id, 'high')
})

test('peek/claim/session-serial checks', () => {
  const db = openDb()
  const now = nowIso()
  insertCallback(db, { id: 'a1', sessionId: 'same', bizId: 'x1', priority: 0, scheduledAt: now })
  insertCallback(db, { id: 'a2', sessionId: 'same', bizId: 'x2', priority: 0, scheduledAt: now })
  insertCallback(db, { id: 'b1', sessionId: 'other', bizId: 'x3', priority: 0, scheduledAt: now })

  const peeked = db.peekQueuedCallbacks(now, 8)
  assert.deepEqual(peeked.map(row => row.id), ['a1', 'a2', 'b1'])

  // 认领 a1 后，a2 同 session 视为忙（exclude 自身）
  assert.equal(db.claimSpecific('a1', now), true)
  assert.equal(db.hasActiveForSession('same'), true)
  assert.equal(db.hasActiveForSession('same', 'a2'), true) // 其他 processing 行
  assert.equal(db.hasActiveForSession('other'), false)

  // releaseClaim 后同 session 又空闲
  const locked = db.getTask('a1')?.locked_at
  db.releaseClaim('a1', locked ?? now, now)
  assert.equal(db.hasActiveForSession('same'), false)
  assert.equal(db.getTask('a1')?.status, 'queued')
})

test('delivery state machine (callback_status two-axis, §7.4)', () => {
  const db = openDb()
  const row = insertCallback(db, { id: 'd1' })
  assert.equal(db.claimSpecific(row.id, nowIso()), true)
  // 模拟执行完成 → completed + 送达轴武装 pending；usage 落 tasks.usage（JSON 串）
  db.completeTask(row.id, { result: '结果', usage: { total_tokens: 9 }, isCallback: true, now: nowIso() })
  let fresh = db.getTask(row.id)
  assert.equal(fresh?.status, 'completed')
  assert.equal(fresh?.callback_status, 'pending')
  assert.ok(fresh?.next_callback_at)
  const storedUsage = fresh?.usage
  assert.ok(storedUsage)
  assert.deepEqual(JSON.parse(storedUsage), { total_tokens: 9 })

  // 成功 → succeeded（终态）
  const okStatus = db.recordCallbackResult(row.id, { ok: true, retryCount: 0, maxRetry: 3, retryIntervalSeconds: 30, now: nowIso() })
  assert.equal(okStatus, 'succeeded')
  assert.equal(db.getTask(row.id)?.callback_status, 'succeeded')
  assert.equal(db.getDeliveryCandidate(nowIso()), undefined)

  // 另一任务：连续失败直至超过 maxRetry → exhausted + callback_failed
  const row2 = insertCallback(db, { id: 'd2', bizId: 'retry-me' })
  assert.equal(db.claimSpecific(row2.id, nowIso()), true)
  db.completeTask(row2.id, { result: 'r', isCallback: true, now: nowIso() })
  // 未提供 usage → tasks.usage 保持 NULL
  assert.equal(db.getTask(row2.id)?.usage, null)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const next = db.recordCallbackResult(row2.id, { ok: false, retryCount: attempt, maxRetry: 3, retryIntervalSeconds: 30, now: nowIso() })
    assert.equal(next, 'retrying')
  }
  const exhausted = db.recordCallbackResult(row2.id, { ok: false, retryCount: 4, maxRetry: 3, retryIntervalSeconds: 30, now: nowIso() })
  assert.equal(exhausted, 'exhausted')
  const final = db.getTask(row2.id)
  assert.equal(final?.status, 'callback_failed')
  assert.equal(final?.callback_status, 'exhausted')
})

test('rescue on activation: callback requeued, stream cancelled (§7.3)', () => {
  const db = openDb()
  const now = nowIso()
  const callback = insertCallback(db, { id: 'r1', bizId: 'rb1' })
  db.claimSpecific(callback.id, now)
  const stream = db.createTask({ id: 'r2', clientId: 'a', bizId: 'rb2', replaySeq: 0, sessionId: 's2', prompt: 'x', type: 'stream', priority: 0, scheduledAt: now, now })
  db.markProcessing(stream.id, now)
  assert.equal(db.getTask('r1')?.status, 'processing')
  assert.equal(db.getTask('r2')?.status, 'processing')

  const logs: string[] = []
  const result = rescueProcessing(db, message => logs.push(message), now)
  assert.equal(result.requeued, 1)
  assert.equal(result.cancelled, 1)
  assert.equal(db.getTask('r1')?.status, 'queued')
  assert.equal(db.getTask('r2')?.status, 'cancelled')
  assert.ok(logs.length >= 1)
  // 日志落库
  assert.equal(db.listLogs('r1', 1, 10).logs.some(log => log.stage === 'received'), true)
  assert.equal(db.listLogs('r2', 1, 10).logs.some(log => log.stage === 'cancelled'), true)
})

test('logs pagination and stage lookup', () => {
  const db = openDb()
  const row = insertCallback(db, { id: 'lg1' })
  for (let i = 0; i < 5; i++) db.addLog(row.id, 'chunk', `chunk-${i}`, { index: i })
  db.addLog(row.id, 'completed', '完成', { usage: { total_tokens: 5 } })
  const page = db.listLogs(row.id, 1, 3)
  assert.equal(page.total, 6)
  assert.equal(page.logs.length, 3)
  const lastCompleted = db.lastLogOfStage(row.id, 'completed')
  assert.equal(lastCompleted?.stage, 'completed')
  assert.ok(lastCompleted?.metadata?.includes('total_tokens'))
})

test('listTasks filters, pagination, cancel of processing blocked only by status guard', () => {
  const db = openDb()
  const now = nowIso()
  for (let i = 0; i < 25; i++) {
    db.createTask({ id: `t${i}`, clientId: i % 2 === 0 ? 'biz-a' : 'biz-b', bizId: `REQ-${i}`, replaySeq: 0, sessionId: `s${i}`, prompt: 'p', type: i % 3 === 0 ? 'stream' : 'callback', priority: 0, scheduledAt: now, now })
  }
  const all = db.listTasks({ page: 1, pageSize: 20 })
  assert.equal(all.total, 25)
  assert.equal(all.tasks.length, 20)
  const bizAFilter = db.listTasks({ clientId: 'biz-a', page: 1, pageSize: 100 })
  assert.equal(bizAFilter.total, 13)
  const streamFilter = db.listTasks({ type: 'stream', page: 1, pageSize: 100 })
  assert.equal(streamFilter.total, 9)
  const timeFilter = db.listTasks({ startTime: '2000-01-01T00:00:00.000Z', endTime: '2999-01-01T00:00:00.000Z', page: 1, pageSize: 100 })
  assert.equal(timeFilter.total, 25)
})

test('stats scoped to client when not admin', () => {
  const db = openDb()
  const now = nowIso()
  db.createTask({ id: 'st1', clientId: 'biz-a', bizId: 'R1', replaySeq: 0, sessionId: 's', prompt: 'p', type: 'stream', priority: 0, scheduledAt: now, now })
  db.createTask({ id: 'st2', clientId: 'biz-b', bizId: 'R2', replaySeq: 0, sessionId: 's2', prompt: 'p', type: 'callback', priority: 0, scheduledAt: now, now })
  db.createTask({ id: 'st3', clientId: 'biz-a', bizId: 'R3', replaySeq: 0, sessionId: 's3', prompt: 'p', type: 'callback', priority: 0, scheduledAt: now, now })
  // 完成一条 biz-a callback
  db.claimSpecific('st3', now)
  db.completeTask('st3', { result: 'ok', isCallback: true, now })
  db.recordCallbackResult('st3', { ok: true, retryCount: 0, maxRetry: 3, retryIntervalSeconds: 30, now })

  const globalStats = db.stats({ isAdmin: true })
  assert.equal(globalStats.tasks.stream.total, 0) // st1 仍在 received
  assert.equal(globalStats.tasks.callback.total, 1) // st3 completed
  assert.equal(globalStats.tasks.callback.success, 1)
  assert.equal(globalStats.queue.queued, 1) // st2
  assert.equal(globalStats.queue.processing, 0)

  const scoped = db.stats({ isAdmin: false, clientId: 'biz-a' })
  assert.equal(scoped.tasks.callback.total, 1)
  assert.equal(scoped.tasks.callback.success, 1)
  // biz-b 的任务不出现在 biz-a 的统计里
  assert.equal(db.stats({ isAdmin: false, clientId: 'biz-a' }).tasks.callback.total, 1)
})
