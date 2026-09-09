/**
 * DSH session/event → 归一化 TurnEvent 解码器（0.1.5 会话日志 v3 对齐）。
 *
 * 隔离粘合点：runner（归约内核）只消费归一化 TurnEvent，本文件负责把 DSH
 * 事件载荷翻译过去——官方事件模型（事件名/载荷/流记录形态）变更只改这里。
 *
 * 设计要点：
 * - 本文件 **不 import 任何 @deepseek-ai 包**，输入输出都是自定结构类型，
 *   因此可脱离 DSH 环境做纯单测（tests/decode.test.ts）。
 * - 解码器对畸形/未知载荷一律防御性跳过并返回 []，绝不抛错污染事件路由。
 * - v3 流模型：assistant/chunk 事件已从 SessionEventMap 移除，token 增量内嵌在
 *   assistant/message 与 assistant/attempt 的 `stream: AssistantStreamRecord[]`
 *   中。本解码器展开 stream（text-chunks / reasoning-chunks / 原始 chunk），
 *   按记录序还原为 text-delta / reasoning-delta 归一化事件；消息全文与 usage
 *   作为一条 assistant-message 事件送达（归约内核据此落 result/usage）。
 */

import type { TurnEndReasonLike, TurnEvent } from '../core/runner.ts'

/** 原始 DSH session/event 载荷的窄视图（结构型，不强依赖 DSH 类型）。 */
export interface SessionEventLike {
  type: string
  data?: unknown
}

interface TextDeltaLike {
  kind: 'text-delta' | 'reasoning-delta'
  text: string
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 从 message.content[] 提取全部 text 块文本（结构与 DSH UserMessage/AssistantMessage 一致）。 */
export function extractTextContent(message: unknown): string {
  const msg = asObject(message)
  if (msg === null) return ''
  const content = msg.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    const b = asObject(block)
    if (b !== null && b.type === 'text' && typeof b.text === 'string') text += b.text
  }
  return text
}

function usageOf(value: unknown): Record<string, unknown> | null {
  const obj = asObject(value)
  return obj
}

/**
 * 展开 v3 内嵌 stream 记录 → 有序增量序列。
 * AssistantStreamRecord：text-chunks（texts 数组）/ reasoning-chunks /
 * tool-call-chunks / 原始 chunk（含 text-delta、reasoning-delta）。
 */
export function unfoldStream(stream: unknown): TextDeltaLike[] {
  if (!Array.isArray(stream)) return []
  const out: TextDeltaLike[] = []
  for (const record of stream) {
    const rec = asObject(record)
    if (rec === null) continue
    if (rec.type === 'text-chunks' && Array.isArray(rec.texts)) {
      for (const frag of rec.texts) {
        if (typeof frag === 'string') out.push({ kind: 'text-delta', text: frag })
      }
    } else if (rec.type === 'reasoning-chunks' && Array.isArray(rec.texts)) {
      for (const frag of rec.texts) {
        if (typeof frag === 'string') out.push({ kind: 'reasoning-delta', text: frag })
      }
    } else if (rec.type === 'chunk') {
      const chunk = asObject(rec.chunk)
      if (chunk !== null && typeof chunk.text === 'string') {
        if (chunk.type === 'text-delta') out.push({ kind: 'text-delta', text: chunk.text })
        else if (chunk.type === 'reasoning-delta') out.push({ kind: 'reasoning-delta', text: chunk.text })
      }
    }
  }
  return out
}

/** 一条 DSH session/event → 0..N 条归一化 TurnEvent（防御性，不抛错）。 */
export function decodeSessionEvent(event: SessionEventLike): TurnEvent[] {
  const data = asObject(event.data)
  if (data === null) return []
  const turn = data.turn
  if (typeof turn !== 'number') return []

  switch (event.type) {
    case 'turn/end': {
      const reason = asObject(data.reason)
      if (reason === null || typeof reason.kind !== 'string') return []
      return [{ type: 'turn-end', turn, reason: reason as unknown as TurnEndReasonLike }]
    }
    case 'assistant/attempt': {
      // 未提交消息的 attempt：stream 内容仅作实时转发（不入 result）
      return unfoldStream(data.stream).map(delta => ({ type: delta.kind, turn, text: delta.text }))
    }
    case 'assistant/message': {
      const text = extractTextContent(data.message)
      const usage = data.usage === null || data.usage === undefined ? null : usageOf(data.usage)
      const events: TurnEvent[] = unfoldStream(data.stream).map(delta => ({ type: delta.kind, turn, text: delta.text }))
      if (text !== '' || usage !== null) {
        events.push({ type: 'assistant-message', turn, text, usage })
      }
      return events
    }
    default:
      return []
  }
}
