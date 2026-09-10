/**
 * Turn 驱动器归约测试（§5.4/§5.5/§9）：归一化 TurnEvent 归约——文本拼接与
 * usage、无 delta 时的全文兜底、turn/end 成败判定、agent/error 兜底去重、
 * 桥接主动取消、同 session 串行互斥。
 *
 * 说明：runner 只消费归一化 TurnEvent；DSH 事件 → TurnEvent 的解码单独在
 * tests/decode.test.ts 覆盖（src/dsh/decode.ts）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RunHub, type DriveableAgent, type TurnEndReasonLike, type TurnEvent } from '../src/core/runner.ts'
import type { ActivityController, TextUserMessage } from '../src/core/runner.ts'
import type { RunOutcome } from '../src/shared/types.ts'

const SESSION = 'session-1'

/** 由测试手动驱动的 agent：runTurn 先同步 followup，事件由测试在 finish() 前注入。 */
class ManualAgent implements DriveableAgent {
  readonly id: string
  followed: TextUserMessage | undefined
  cancelReason: string | undefined
  private resolveIdle!: () => void
  private readonly idle: Promise<void>

  constructor(id: string = SESSION) {
    this.id = id
    this.idle = new Promise<void>((resolve) => { this.resolveIdle = resolve })
  }

  followup(message: TextUserMessage): void {
    this.followed = message
  }

  cancel(reason: string): void {
    this.cancelReason = reason
  }

  whenIdle(): Promise<void> {
    return this.idle
  }

  finish(): void {
    this.resolveIdle()
  }
}

function makeActivity(): ActivityController & { events: Array<[string, string]> } {
  const events: Array<[string, string]> = []
  return {
    events,
    begin: (sessionId: string) => events.push([sessionId, 'begin']),
    end: (sessionId: string) => events.push([sessionId, 'end']),
  }
}

let messageSeq = 0
function factory(text: string): TextUserMessage {
  return { id: `msg-${++messageSeq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function textDelta(turn: number, text: string): TurnEvent {
  return { type: 'text-delta', turn, text }
}

function reasoningDelta(turn: number, text = '隐藏推理'): TurnEvent {
  return { type: 'reasoning-delta', turn, text }
}

function assistantMessage(turn: number, text: string, usage?: Record<string, unknown>): TurnEvent {
  return { type: 'assistant-message', turn, text, usage: usage ?? null }
}

function turnEnd(turn: number, reason: TurnEndReasonLike): TurnEvent {
  return { type: 'turn-end', turn, reason }
}

async function drive(events: TurnEvent[]): Promise<{ outcome: RunOutcome; activity: ReturnType<typeof makeActivity>; agent: ManualAgent }> {
  const activity = makeActivity()
  const hub = new RunHub(activity)
  const agent = new ManualAgent()
  const pending = hub.runTurn({ sessionId: SESSION, taskId: 'task-1', prompt: '你好', agent, messageFactory: factory })
  assert.ok(agent.followed, 'followup must be called synchronously')
  // 模拟 driver：claim 消息 → 派发事件 → 收敛
  hub.onMessageClaimed(SESSION, agent.followed.id, 1)
  for (const event of events) hub.onSessionEvent(SESSION, event)
  agent.finish()
  const outcome = await pending
  return { outcome, activity, agent }
}

test('completed turn concatenates text-delta only and carries usage', async () => {
  const { outcome, activity, agent } = await drive([
    textDelta(1, '你'),
    reasoningDelta(1),
    textDelta(1, '好'),
    assistantMessage(1, '你好', { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }),
    turnEnd(1, { kind: 'completed' }),
  ])
  assert.equal(outcome.kind, 'completed')
  assert.equal(outcome.result, '你好') // reasoning-delta 不入 result（§5.5）
  assert.equal(outcome.usage?.total_tokens, 3)
  assert.equal(activity.events[0]?.[1], 'begin')
  assert.equal(activity.events.at(-1)?.[1], 'end')
  assert.equal(agent.cancelReason, undefined)
})

test('message without preceding delta falls back to its full text (SSE + result)', async () => {
  const textFrames: string[] = []
  const messages: Array<{ text: string }> = []
  const activity = makeActivity()
  const hub = new RunHub(activity)
  const agent = new ManualAgent()
  const pending = hub.runTurn({
    sessionId: SESSION,
    taskId: 'task-2',
    prompt: 'p',
    agent,
    messageFactory: factory,
    onTextDelta: (text: string) => textFrames.push(text),
    onAssistantMessage: (turn, text) => messages.push({ text }),
  })
  hub.onMessageClaimed(SESSION, agent.followed?.id ?? '', 1)
  // 无 text-delta 前缀：assistant-message 本身作为兜底输出
  hub.onSessionEvent(SESSION, assistantMessage(1, 'ab'))
  hub.onSessionEvent(SESSION, turnEnd(1, { kind: 'completed' }))
  agent.finish()
  const outcome = await pending
  assert.equal(outcome.kind, 'completed')
  assert.deepEqual(textFrames, ['ab'])
  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.text, 'ab')
  assert.equal(outcome.result, 'ab')
})

test('text-delta stream frames forward per delta', async () => {
  const textFrames: string[] = []
  const reasoningFrames: string[] = []
  const activity = makeActivity()
  const hub = new RunHub(activity)
  const agent = new ManualAgent()
  const pending = hub.runTurn({
    sessionId: SESSION,
    taskId: 'task-3',
    prompt: 'p',
    agent,
    messageFactory: factory,
    onTextDelta: (text: string) => textFrames.push(text),
    onReasoningDelta: (text: string) => reasoningFrames.push(text),
  })
  hub.onMessageClaimed(SESSION, agent.followed?.id ?? '', 1)
  hub.onSessionEvent(SESSION, textDelta(1, 'a'))
  hub.onSessionEvent(SESSION, reasoningDelta(1, 'r1'))
  hub.onSessionEvent(SESSION, textDelta(1, 'b'))
  hub.onSessionEvent(SESSION, assistantMessage(1, 'ab'))
  hub.onSessionEvent(SESSION, turnEnd(1, { kind: 'completed' }))
  agent.finish()
  const outcome = await pending
  assert.equal(outcome.kind, 'completed')
  assert.deepEqual(textFrames, ['a', 'b'])
  assert.deepEqual(reasoningFrames, ['r1'])
  assert.equal(outcome.result, 'ab')
})

test('turn/end error maps to failed with reason detail', async () => {
  const { outcome } = await drive([
    turnEnd(1, { kind: 'error', error: { message: 'rate limited', code: 'RATE_LIMIT' } }),
  ])
  assert.equal(outcome.kind, 'failed')
  assert.ok(outcome.message.includes('rate limited'))
  assert.equal(outcome.result, '')
})

test('blocked and max-tokens and unknown kinds map to failed', async () => {
  for (const reasonKind of ['blocked', 'max-tokens', 'interrupted', 'mystery']) {
    const { outcome } = await drive([turnEnd(1, { kind: reasonKind })])
    assert.equal(outcome.kind, 'failed', `kind ${reasonKind} should fail`)
  }
})

test('aborted without bridge cancel is failed', async () => {
  const { outcome } = await drive([turnEnd(1, { kind: 'aborted', reason: { kind: 'user' } })])
  assert.equal(outcome.kind, 'failed')
  assert.ok(outcome.message.includes('aborted'))
})

test('bridge cancel leads to cancelled and agent.cancel called', async () => {
  const activity = makeActivity()
  const hub = new RunHub(activity)
  const agent = new ManualAgent()
  const pending = hub.runTurn({ sessionId: SESSION, taskId: 'task-c', prompt: 'p', agent, messageFactory: factory })
  hub.onMessageClaimed(SESSION, agent.followed?.id ?? '', 1)
  hub.onSessionEvent(SESSION, textDelta(1, '部分'))
  assert.equal(hub.cancel(SESSION, 'client disconnected'), true)
  hub.onSessionEvent(SESSION, turnEnd(1, { kind: 'aborted', reason: { kind: 'hook', reason: 'bizbridge: client disconnected' } }))
  agent.finish()
  const outcome = await pending
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(agent.cancelReason, 'bizbridge: client disconnected')
  assert.equal(hub.isBusy(SESSION), false)
})

test('agent/error fallback fails task when no turn/end arrives', async () => {
  const activity = makeActivity()
  const hub = new RunHub(activity)
  const agent = new ManualAgent()
  const pending = hub.runTurn({ sessionId: SESSION, taskId: 'task-e', prompt: 'p', agent, messageFactory: factory })
  hub.onAgentError(SESSION, new Error('interval failure'))
  agent.finish()
  const outcome = await pending
  assert.equal(outcome.kind, 'failed')
  assert.ok(outcome.message.includes('interval failure'))
})

test('session serialization: second run on same session rejected while active', async () => {
  const activity = makeActivity()
  const hub = new RunHub(activity)
  const agent = new ManualAgent()
  const first = hub.runTurn({ sessionId: SESSION, taskId: 'task-1', prompt: 'p', agent, messageFactory: factory })
  await assert.rejects(
    () => hub.runTurn({ sessionId: SESSION, taskId: 'task-2', prompt: 'p2', agent: new ManualAgent(), messageFactory: factory }),
    /already has a running task/,
  )
  agent.finish()
  await first
  // 收敛后可再跑
  const agent2 = new ManualAgent()
  const second = hub.runTurn({ sessionId: SESSION, taskId: 'task-3', prompt: 'p3', agent: agent2, messageFactory: factory })
  hub.onSessionEvent(SESSION, turnEnd(1, { kind: 'completed' }))
  agent2.finish()
  const outcome = await second
  assert.equal(outcome.kind, 'completed')
})

test('RunHub.reserve: 同会话并发占位互斥（消除预检→runTurn 之间的竞态窗口）', () => {
  const hub = new RunHub(makeActivity())
  assert.equal(hub.reserve('s1'), true)
  // 第二个并发请求必须被拒。修复前两次预检都会通过，第二个随后在 openAgent 撞上
  // DSH 的 "already owned by an active write handle" 而落 500（真机 3/3 复现）。
  assert.equal(hub.reserve('s1'), false)
  assert.equal(hub.isBusy('s1'), true)
  // 其他会话不受影响
  assert.equal(hub.reserve('s2'), true)
  // 释放后可再次占位
  hub.release('s1')
  assert.equal(hub.isBusy('s1'), false)
  assert.equal(hub.reserve('s1'), true)
})

test('RunHub.reserve: 运行期间占位被拒，收敛后可再次占位', async () => {
  const hub = new RunHub(makeActivity())
  const agent = new ManualAgent()
  const pending = hub.runTurn({ sessionId: SESSION, taskId: 'task-1', prompt: 'p', agent, messageFactory: factory })
  assert.equal(hub.reserve(SESSION), false)
  hub.onSessionEvent(SESSION, turnEnd(1, { kind: 'completed' }))
  agent.finish()
  await pending
  assert.equal(hub.reserve(SESSION), true)
  hub.release(SESSION)
  assert.equal(hub.isBusy(SESSION), false)
})
