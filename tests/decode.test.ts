/**
 * session/event → TurnEvent 解码器测试（src/dsh/decode.ts，DSH 0.1.5 v3 流模型）。
 *
 * 验证点：assistant/message 内嵌 stream 展开为增量、全文与 usage 组装成
 * assistant-message 事件、attempt 仅产生实时增量、reasoning 与 text 顺序保持、
 * turn/end 映射、畸形/未知事件防御性为空。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeSessionEvent, extractTextContent, unfoldStream } from '../src/dsh/decode.ts'
import type { SessionEventLike } from '../src/dsh/decode.ts'

function textChunks(texts: string[], index = 0) {
  return { type: 'text-chunks', time0: 1000, index, dt: texts.map(() => 5), texts }
}

function reasoningChunks(texts: string[], index = 0) {
  return { type: 'reasoning-chunks', time0: 1000, index, dt: texts.map(() => 5), texts }
}

function rawTextDelta(text: string) {
  return { type: 'chunk', time: 1000, chunk: { type: 'text-delta', index: 0, text } }
}

test('extractTextContent joins text blocks only', () => {
  const message = { content: [
    { type: 'text', text: '你好' },
    { type: 'tool_call', name: 'x' },
    { type: 'text', text: '世界' },
  ] }
  assert.equal(extractTextContent(message), '你好世界')
  assert.equal(extractTextContent(null), '')
  assert.equal(extractTextContent({ content: 'nope' }), '')
})

test('unfoldStream expands compact and raw records in order', () => {
  const stream = [
    reasoningChunks(['推理一']),
    textChunks(['你', '好']),
    rawTextDelta('！'),
    { type: 'tool-call-chunks', index: 0, id: 'call-1', args: ['a'] },
    { type: 'bogus' },
  ]
  assert.deepEqual(unfoldStream(stream), [
    { kind: 'reasoning-delta', text: '推理一' },
    { kind: 'text-delta', text: '你' },
    { kind: 'text-delta', text: '好' },
    { kind: 'text-delta', text: '！' },
  ])
})

test('assistant/message decodes to ordered deltas then message event', () => {
  const raw: SessionEventLike = {
    type: 'assistant/message',
    data: {
      turn: 3,
      step: 1,
      message: { content: [{ type: 'text', text: '你好！' }] },
      stream: [textChunks(['你', '好']), rawTextDelta('！')],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  }
  const events = decodeSessionEvent(raw)
  assert.equal(events.length, 4)
  assert.deepEqual(events.slice(0, 3), [
    { type: 'text-delta', turn: 3, text: '你' },
    { type: 'text-delta', turn: 3, text: '好' },
    { type: 'text-delta', turn: 3, text: '！' },
  ])
  assert.deepEqual(events[3], { type: 'assistant-message', turn: 3, text: '你好！', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
})

test('assistant/message without stream still yields message event (full-text fallback)', () => {
  const raw: SessionEventLike = {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '仅全文' }] } },
  }
  const events = decodeSessionEvent(raw)
  assert.equal(events.length, 1)
  assert.deepEqual(events[0], { type: 'assistant-message', turn: 1, text: '仅全文', usage: null })
})

test('assistant/attempt decodes to live deltas only (no message event)', () => {
  const raw: SessionEventLike = {
    type: 'assistant/attempt',
    data: { turn: 2, step: 1, stream: [textChunks(['半'], 1), reasoningChunks(['被中止的推理'])] },
  }
  assert.deepEqual(decodeSessionEvent(raw), [
    { type: 'text-delta', turn: 2, text: '半' },
    { type: 'reasoning-delta', turn: 2, text: '被中止的推理' },
  ])
})

test('turn/end decodes with reason; missing reason yields nothing', () => {
  assert.deepEqual(decodeSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }), [
    { type: 'turn-end', turn: 1, reason: { kind: 'completed' } },
  ])
  assert.deepEqual(decodeSessionEvent({ type: 'turn/end', data: { turn: 1 } }), [])
})

test('unknown / malformed events decode defensively to empty', () => {
  assert.deepEqual(decodeSessionEvent({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'x', arguments: '{}' } }), [])
  assert.deepEqual(decodeSessionEvent({ type: 'assistant/message', data: null }), [])
  assert.deepEqual(decodeSessionEvent({ type: 'assistant/message', data: { message: {} } }), []) // 缺 turn
  assert.deepEqual(decodeSessionEvent({ type: 'assistant/message' }), [])
  assert.deepEqual(decodeSessionEvent({ type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'text-delta', text: '旧版事件' } } }), [])
})
