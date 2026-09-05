/**
 * 会话桥接层测试（§5.2）：openAgent 决策流（live 复用 / resume / create /
 * already-exists 兜底 / cwd 校验 / 非持有活跃会话 409）、并发激活去重、
 * 空闲回收守卫与 disposeAll。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { AgentPool, sameDirectory, type BridgeAgent, type SessionGateway } from '../src/core/session-bridge.ts'
import { CwdMismatchError, SessionBusyError } from '../src/shared/errors.ts'

function makeAgent(id: string, state: { idle: () => boolean }): BridgeAgent & { disposed: boolean } {
  return {
    id,
    disposed: false,
    get idle(): boolean {
      return state.idle()
    },
    followup(): void {},
    cancel(): void {},
    whenIdle(): Promise<void> {
      return Promise.resolve()
    },
    async dispose(): Promise<void> {
      this.disposed = true
      state.idle = () => true
    },
  }
}

interface GatewayOptions {
  persisted?: Record<string, { cwd?: string }>
  live?: Set<string>
  createError?: Error
  deferredCreate?: boolean
}

function makeGateway(options: GatewayOptions = {}) {
  const live = new Set<string>(options.live ?? [])
  const persisted = new Map(Object.entries(options.persisted ?? {}))
  const created = new Map<string, BridgeAgent & { disposed: boolean }>()
  let createCalls = 0
  let resumeCalls = 0
  let deferred: { resolve: () => void } | undefined
  const createStarted = new Promise<void>((resolve) => { deferred = { resolve } })

  const register = (sessionId: string, from: 'create' | 'resume'): BridgeAgent & { disposed: boolean } => {
    const agent = makeAgent(sessionId, { idle: () => true })
    const originalDispose = agent.dispose
    agent.dispose = async (): Promise<void> => {
      await originalDispose.call(agent)
      live.delete(sessionId)
    }
    created.set(sessionId, agent)
    live.add(sessionId)
    void from
    return agent
  }

  const gateway: SessionGateway = {
    liveSessionExists(sessionId: string): boolean {
      return live.has(sessionId)
    },
    async persistedStat(sessionId: string) {
      const header = persisted.get(sessionId)
      return header === undefined ? undefined : { header }
    },
    currentCwd(): string {
      return process.cwd()
    },
    createAgent(sessionId: string): Promise<BridgeAgent> {
      createCalls++
      if (options.createError !== undefined) return Promise.reject(options.createError)
      if (options.deferredCreate === true) {
        return new Promise((resolve) => {
          deferred?.resolve()
          resolve(register(sessionId, 'create'))
        })
      }
      return Promise.resolve(register(sessionId, 'create'))
    },
    resumeAgent(sessionId: string): Promise<BridgeAgent> {
      resumeCalls++
      return Promise.resolve(register(sessionId, 'resume'))
    },
  }
  return {
    gateway,
    live,
    created,
    stats: () => ({ createCalls, resumeCalls }),
    awaitCreateStarted(): Promise<void> {
      return options.deferredCreate === true ? createStarted : Promise.resolve()
    },
  }
}

test('decision flow: fresh create (c) then live reuse (a)', async () => {
  const env = makeGateway()
  const pool = new AgentPool(env.gateway, 10)
  const first = await pool.openAgent('session-x')
  assert.equal(env.stats().createCalls, 1)
  assert.equal(env.stats().resumeCalls, 0)
  assert.equal(pool.owns('session-x'), true)
  const second = await pool.openAgent('session-x')
  assert.equal(second.id, 'session-x')
  assert.equal(env.stats().createCalls, 1, 'live handle reused, no new create')
})

test('decision flow: persisted session resumes (b)', async () => {
  const env = makeGateway({ persisted: { 'old-session': { cwd: process.cwd() } } })
  const pool = new AgentPool(env.gateway, 10)
  const agent = await pool.openAgent('old-session')
  assert.equal(env.stats().createCalls, 0)
  assert.equal(env.stats().resumeCalls, 1)
  assert.equal(agent.id, 'old-session')
})

test('decision flow: persisted cwd mismatch rejects (cwd 校验)', async () => {
  const wrongCwd = join(process.cwd(), '..', 'somewhere-else')
  const env = makeGateway({ persisted: { s: { cwd: wrongCwd } } })
  const pool = new AgentPool(env.gateway, 10)
  await assert.rejects(() => pool.openAgent('s'), CwdMismatchError)
  assert.equal(env.stats().resumeCalls, 0)
})

test('decision flow: create already-exists falls back to resume only for that error', async () => {
  const env = makeGateway({ createError: new Error('session "s" already exists') })
  const pool = new AgentPool(env.gateway, 10)
  await pool.openAgent('s')
  assert.equal(env.stats().createCalls, 1)
  assert.equal(env.stats().resumeCalls, 1)
})

test('decision flow: non-already-exists create errors propagate', async () => {
  const env = makeGateway({ createError: new Error('persistence broken') })
  const pool = new AgentPool(env.gateway, 10)
  await assert.rejects(() => pool.openAgent('s'), /persistence broken/)
  assert.equal(env.stats().resumeCalls, 0)
})

test('decision flow: live session not owned by bridge → SessionBusy (不接管)', async () => {
  const env = makeGateway({ live: new Set(['foreign']) })
  const pool = new AgentPool(env.gateway, 10)
  await assert.rejects(() => pool.openAgent('foreign'), SessionBusyError)
  assert.equal(env.stats().createCalls, 0)
  assert.equal(env.stats().resumeCalls, 0)
})

test('concurrent openAgent deduplicates activation (activating 去重)', async () => {
  const env = makeGateway({ deferredCreate: true })
  const pool = new AgentPool(env.gateway, 10)
  const first = pool.openAgent('session-x')
  const second = pool.openAgent('session-x')
  await env.awaitCreateStarted()
  const [a, b] = await Promise.all([first, second])
  assert.equal(env.stats().createCalls, 1)
  assert.equal(a.id, b.id)
})

test('idle reaper: guards (busy / running / within timeout) and recovery by resume', async () => {
  let now = 1_000_000
  const env = makeGateway({ persisted: { 'idle-session': { cwd: process.cwd() } } })
  const pool = new AgentPool(env.gateway, 1, () => now) // idleTimeout = 1 min
  const agent = await pool.openAgent('idle-session')
  assert.ok(agent)

  // ① 进行中任务 → 不回收
  pool.beginActivity('idle-session')
  now += 120_000
  assert.deepEqual(pool.reapIdle(), [])
  pool.endActivity('idle-session')

  // ② 未超时 → 不回收
  now += 30_000
  assert.deepEqual(pool.reapIdle(), [])

  // ③ 超时 → 回收并 dispose
  now += 60_000
  const reaped = pool.reapIdle()
  assert.equal(reaped.length, 1)
  assert.equal(pool.owns('idle-session'), false)
  await new Promise(resolve => setTimeout(resolve, 0)) // 等待异步 dispose 从 live 摘除

  // ④ 回收后下次 openAgent 经路径 b resume 恢复
  const again = await pool.openAgent('idle-session')
  assert.equal(again.id, 'idle-session')
  assert.equal(env.stats().resumeCalls, 2)
})

test('idleTimeout = 0 disables reaping', async () => {
  let now = 1
  const env = makeGateway()
  const pool = new AgentPool(env.gateway, 0, () => now)
  await pool.openAgent('s')
  now += 10_000_000
  assert.deepEqual(pool.reapIdle(), [])
})

test('pruneDisposed drops stale registry entry', async () => {
  const env = makeGateway({ persisted: { s: { cwd: process.cwd() } } })
  const pool = new AgentPool(env.gateway, 10)
  await pool.openAgent('s')
  assert.equal(pool.owns('s'), true)
  pool.pruneDisposed('s')
  assert.equal(pool.owns('s'), false)
})

test('disposeAll disposes every handle and closes the pool', async () => {
  const env = makeGateway({ persisted: { a: { cwd: process.cwd() }, b: { cwd: process.cwd() } } })
  const pool = new AgentPool(env.gateway, 10)
  await pool.openAgent('a')
  await pool.openAgent('b')
  await pool.disposeAll()
  for (const agent of env.created.values()) assert.equal(agent.disposed, true)
  await assert.rejects(() => pool.openAgent('a'), /disposed/)
})

test('sameDirectory compares physical identity and lexical fallback', async () => {
  assert.equal(await sameDirectory(process.cwd(), process.cwd()), true)
  const other = join(process.cwd(), '..', 'other')
  assert.equal(await sameDirectory(process.cwd(), other), false)
})
