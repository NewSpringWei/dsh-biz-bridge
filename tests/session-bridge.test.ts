/**
 * AgentPool 决策流测试（§5.2/§5.2.1）——当前 AgentPool API：
 * live → resume → create；per-client workspace 期望 cwd 校验（草创期破坏性改版）。
 * 生命周期特性（owns/reap/dispose/prune/activating 去重）已随 DSH 重构移除，不在此覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentPool, type PersistedSessionProbe, type SessionGateway } from '../src/core/session-bridge.ts'
import type { AgentParamOverrides, TextUserMessage } from '../src/shared/types.ts'
import type { BridgeAgent } from '../src/core/session-bridge.ts'
import { CwdMismatchError } from '../src/shared/errors.ts'

const WS = 'E:/ws'
const SESSION = 'biz-a:stream:sess-1'

function fakeAgent(id: string): BridgeAgent {
  return {
    id,
    idle: true,
    followup(_m: TextUserMessage): void { /* noop */ },
    cancel(_reason: string): void { /* noop */ },
    whenIdle(): Promise<void> { return Promise.resolve() },
    dispose(): Promise<void> { return Promise.resolve() },
  }
}

class AlreadyExistsLike extends Error { }

/** 可控 fake 网关：记录调用、按预设状态驱动决策流。 */
function makeGateway(overrides: Partial<{
  live: boolean
  persisted: PersistedSessionProbe | undefined
  createFails: Error | undefined
}> = {}): SessionGateway & { calls: string[]; lastAgentOptions?: AgentParamOverrides } {
  const calls: string[] = []
  return {
    calls,
    liveAgent(sessionId: string): BridgeAgent | undefined {
      calls.push(`live:${sessionId}`)
      return overrides.live === true ? fakeAgent(sessionId) : undefined
    },
    async persistedStat(sessionId: string): Promise<PersistedSessionProbe | undefined> {
      calls.push(`stat:${sessionId}`)
      return overrides.persisted
    },
    workspaceOf(sessionId: string): string {
      calls.push(`ws:${sessionId}`)
      // per-client：biz-a → E:/ws/biz-a
      return `${WS}/${sessionId.split(':')[0]}`
    },
    async createAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
      calls.push(`create:${sessionId}`)
      if (overrides.createFails !== undefined) throw overrides.createFails
      this.lastAgentOptions = agentOptions
      return fakeAgent(sessionId)
    },
    async resumeAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
      calls.push(`resume:${sessionId}`)
      this.lastAgentOptions = agentOptions
      return fakeAgent(sessionId)
    },
  }
}

test('live agent exists → reuse directly (no stat/resume/cwd check)', async () => {
  const gateway = makeGateway({ live: true })
  const pool = new AgentPool(gateway)
  const agent = await pool.openAgent(SESSION)
  assert.equal(agent.id, SESSION)
  // live 复用绝不 resume：resume 会与 live 会话的持久写句柄冲突
  assert.deepEqual(gateway.calls, [`live:${SESSION}`])
})

test('no live agent, persisted cwd matches the client workspace → resume', async () => {
  const gateway = makeGateway({ persisted: { header: { cwd: `${WS}/biz-a` } } })
  const pool = new AgentPool(gateway)
  await pool.openAgent(SESSION)
  assert.deepEqual(gateway.calls, [`live:${SESSION}`, `stat:${SESSION}`, `ws:${SESSION}`, `resume:${SESSION}`])
})

test('persisted session with a mismatched cwd → CwdMismatchError', async () => {
  const gateway = makeGateway({ persisted: { header: { cwd: `${WS}/other-client` } } })
  const pool = new AgentPool(gateway)
  await assert.rejects(
    () => pool.openAgent(SESSION),
    (error: unknown) => {
      assert.ok(error instanceof CwdMismatchError)
      assert.ok(error.message.includes(SESSION))
      return true
    },
  )
})

test('persisted session without cwd header → resume allowed (no check)', async () => {
  const gateway = makeGateway({ persisted: { header: {} } })
  const pool = new AgentPool(gateway)
  await pool.openAgent(SESSION)
  assert.deepEqual(gateway.calls, [`live:${SESSION}`, `stat:${SESSION}`, `resume:${SESSION}`])
})

test('fresh session → create (create resolves the client workspace internally)', async () => {
  const gateway = makeGateway()
  const pool = new AgentPool(gateway)
  await pool.openAgent(SESSION)
  assert.deepEqual(gateway.calls, [`live:${SESSION}`, `stat:${SESSION}`, `create:${SESSION}`])
})

test('create already-exists error falls back to resume', async () => {
  const gateway = makeGateway({ createFails: new AlreadyExistsLike('already exists') })
  const pool = new AgentPool(gateway)
  const agent = await pool.openAgent(SESSION)
  assert.equal(agent.id, SESSION)
  assert.deepEqual(gateway.calls, [`live:${SESSION}`, `stat:${SESSION}`, `create:${SESSION}`, `resume:${SESSION}`])
})

test('non already-exists create errors propagate', async () => {
  const boom = new Error('boom')
  const gateway = makeGateway({ createFails: boom })
  const pool = new AgentPool(gateway)
  await assert.rejects(() => pool.openAgent(SESSION), /boom/)
})

test('per-client workspace: different clients resolve different cwds', async () => {
  const gateway = makeGateway()
  assert.equal(gateway.workspaceOf('biz-a:stream:s-1'), `${WS}/biz-a`)
  assert.equal(gateway.workspaceOf('biz-b:cb:s-2'), `${WS}/biz-b`)
})

test('session busy guard tracks activities', async () => {
  const gateway = makeGateway()
  const pool = new AgentPool(gateway)
  assert.equal(pool.isBusy(SESSION), false)
  pool.beginActivity(SESSION)
  assert.equal(pool.isBusy(SESSION), true)
  pool.endActivity(SESSION)
  assert.equal(pool.isBusy(SESSION), false)
})
