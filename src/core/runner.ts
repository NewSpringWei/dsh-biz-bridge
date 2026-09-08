/**
 * Turn 驱动器与事件归约（§5.5 通用执行内核）——结构化实现，供流式/回调两路
 * executor 复用；对事件流的消费只依赖本文件内定义的窄类型，不 import DSH 包，
 * 因此可用 fake agent 单测。
 *
 * 事件流向：DSH 的 session/event / agent/inbox/claimed / agent/error 是插件级
 * 广播（对齐 ACP 桥接先例），由 index.ts 的全局监听器按 sessionId 路由到本
 * hub；hub 内同一 session 同时至多一个 ActiveRun（§5.8 会话串行化保证）。
 *
 * 归约语义（§5.4/§5.5/§9）：
 * - result = 本任务 turn 内全部 assistant/chunk(text-delta) 文本按事件序拼接；
 * - usage = 本 turn 最后一条 assistant/message 的 usage；
 * - 成败以本 turn 的 turn/end reason.kind 判定；agent/error 兜底去重；
 * - bridge 主动 cancel（断连/管理取消）→ cancelled。
 */

import type { RunOutcome, TextMessageFactory, TextUserMessage } from '../shared/types.ts'

export type { TextMessageFactory, TextUserMessage }

/** turn/end reason 的 JSON 安全视图。 */
export interface TurnEndReasonLike {
  kind: string
  reason?: Record<string, unknown>
  error?: { message?: string; code?: string } | null
}

/** 可驱动 agent 的最小面（真实 Agent 由 gateway 适配）。 */
export interface DriveableAgent {
  readonly id: string
  followup(message: TextUserMessage): void
  /** 桥接主动取消（内部包装 cause={kind:'hook',reason}）。 */
  cancel(reason: string): void
  whenIdle(): Promise<void>
}

/** 事件负载的窄视图。 */
interface EventPayload {
  turn?: number
  step?: number
  chunk?: { type?: string; text?: string }
  message?: unknown
  usage?: Record<string, unknown> | null
  reason?: TurnEndReasonLike
}

export interface SessionEventLike {
  type: string
  data?: unknown
}

/** activity 控制器（真实实现为 AgentPool；测试可注入 fake）。 */
export interface ActivityController {
  begin(sessionId: string): void
  end(sessionId: string): void
}

/** run 配置与事件回调。 */
export interface RunConfig {
  sessionId: string
  taskId: string
  /** 流式：text-delta 实时转发（SSE）；回调侧不提供。 */
  onTextDelta?: (text: string) => void
  /** 流式：reasoning-delta 实时转发（思考型模型的推理过程）。 */
  onReasoningDelta?: (text: string) => void
  /** 每条 assistant/message 收尾时回调（日志/落库）；参数为该消息内文本与 usage。 */
  onAssistantMessage?: (turn: number, text: string, usage: Record<string, unknown> | null) => void
}

const TERMINAL_END_KINDS = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted'])

function payloadOf(event: SessionEventLike): EventPayload {
  return (event.data ?? {}) as EventPayload
}

function textOfMessage(message: unknown): string {
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

/** 单个活动任务的状态收集器。 */
class ActiveRun {
  /** 消息被 driver claim 后分配的 turn 号。 */
  turn: number | undefined
  reason: TurnEndReasonLike | undefined
  usage: Record<string, unknown> | null = null
  collected = ''
  cancelRequested = false
  agentError: string | undefined
  /** 消息是否已被 claim（≥1 个 user/message 或 inbox/claimed 到达）。 */
  started = false
  /** 本 turn 是否已收到 text-delta（用于 onAssistantMessage 兜底判断）。 */
  hasTextDelta = false

  private readonly agent: DriveableAgent
  private readonly messageId: string
  private readonly config: RunConfig

  constructor(agent: DriveableAgent, messageId: string, config: RunConfig) {
    this.agent = agent
    this.messageId = messageId
    this.config = config
  }

  onMessageClaimed(messageId: string, turn: number): void {
    if (messageId !== this.messageId) return
    this.turn = turn
    this.started = true
  }

  onAgentError(error: unknown): void {
    if (this.agentError === undefined) {
      this.agentError = error instanceof Error ? error.message : String(error)
    }
  }

  /** 由桥接主动取消（断连 / 管理取消）。 */
  requestCancel(reason: string): void {
    this.cancelRequested = true
    try {
      this.agent.cancel(`bizbridge: ${reason}`)
    } catch (error: unknown) {
      this.onAgentError(error)
    }
  }

  handleEvent(event: SessionEventLike): void {
    const payload = payloadOf(event)
    const inOurTurn = this.turn === undefined || payload.turn === this.turn
    switch (event.type) {
      case 'assistant/chunk': {
        if (!inOurTurn) return
        const chunk = payload.chunk
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          this.collected += chunk.text
          this.hasTextDelta = true
          this.config.onTextDelta?.(chunk.text)
        } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          // 思考型模型的推理过程，作为 reasoning 事件转发
          this.config.onReasoningDelta?.(chunk.text)
        }
        return
      }
      case 'assistant/message': {
        if (!inOurTurn) return
        if (payload.usage !== undefined && payload.usage !== null) this.usage = payload.usage
        const text = textOfMessage(payload.message)
        if (text !== '') {
          this.config.onAssistantMessage?.(payload.turn ?? 0, text, this.usage)
          // 兜底：若模型未产生 text-delta（纯推理模型或 DSH 版本差异），
          // 在此推送最终文本并收集到 result 中。
          if (!this.hasTextDelta) {
            this.collected += text
            this.config.onTextDelta?.(text)
          }
        }
        return
      }
      case 'turn/end': {
        if (!inOurTurn) return
        if (payload.reason !== undefined) this.reason = payload.reason
        return
      }
      default:
        return
    }
  }

  /** 收敛后归约结局（§5.4 成败判定）。 */
  settle(): RunOutcome {
    if (this.cancelRequested) {
      return { kind: 'cancelled', result: '', message: '任务已被取消' }
    }
    if (this.reason === undefined) {
      const detail = this.agentError === undefined
        ? '任务未产生 turn/end 事件（可能被外部取消或 agent 不可用）'
        : `agent error: ${this.agentError}`
      return { kind: 'failed', result: '', message: detail }
    }
    const kind = this.reason.kind
    if (kind === 'completed') {
      return {
        kind: 'completed',
        result: this.collected,
        message: 'completed',
        usage: this.usage,
        reason: safeReason(this.reason),
      }
    }
    if (kind === 'aborted') {
      if (this.cancelRequested) {
        return { kind: 'cancelled', result: '', message: '任务已被取消', reason: safeReason(this.reason) }
      }
      const causeKind = (this.reason.reason as { kind?: string } | undefined)?.kind ?? 'unknown'
      return {
        kind: 'failed',
        result: '',
        message: `agent turn aborted (cause: ${causeKind})`,
        reason: safeReason(this.reason),
      }
    }
    const detail = errorDetail(this.reason)
    return { kind: 'failed', result: '', message: detail, reason: safeReason(this.reason) }
  }
}

function errorDetail(reason: TurnEndReasonLike): string {
  if (reason.kind === 'error') {
    const error = reason.error
    if (error?.message !== undefined && error.message !== '') return `agent turn failed: ${error.message}`
    return `agent turn failed (code: ${error?.code ?? 'UNKNOWN'})`
  }
  return `agent turn ended with reason "${reason.kind}"`
}

function safeReason(reason: TurnEndReasonLike): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: reason.kind }
  if (reason.reason !== undefined) out.reason = reason.reason
  if (reason.error !== undefined) out.error = reason.error
  return out
}

/** 由外部（index.ts 的全局监听器）按 sessionId 路由到活动 run。 */
export class RunHub {
  private readonly active = new Map<string, ActiveRun>()
  private readonly activity: ActivityController

  constructor(activity: ActivityController) {
    this.activity = activity
  }

  /**
   * 在一个会话上执行一轮用户消息驱动的 turn，直到 agent 收敛（§5.5 步骤 6）。
   * 调用前必须已通过 openAgent 取到 agent，且该会话无其他进行中任务。
   */
  async runTurn(input: {
    sessionId: string
    taskId: string
    prompt: string
    agent: DriveableAgent
    messageFactory: TextMessageFactory
    onTextDelta?: (text: string) => void
    onAssistantMessage?: (turn: number, text: string, usage: Record<string, unknown> | null) => void
  }): Promise<RunOutcome> {
    const { sessionId } = input
    if (this.active.has(sessionId)) {
      throw new Error(`dsh-biz-bridge: session "${sessionId}" already has a running task`)
    }
    const message = input.messageFactory(input.prompt)
    const run = new ActiveRun(input.agent, message.id, {
      sessionId,
      taskId: input.taskId,
      onTextDelta: input.onTextDelta,
      onAssistantMessage: input.onAssistantMessage,
    })
    this.active.set(sessionId, run)
    this.activity.begin(sessionId)
    try {
      input.agent.followup(message)
      await input.agent.whenIdle()
      return run.settle()
    } catch (error: unknown) {
      run.onAgentError(error)
      return run.settle()
    } finally {
      if (this.active.get(sessionId) === run) this.active.delete(sessionId)
      this.activity.end(sessionId)
    }
  }

  /** 路由 session/event（index.ts 全局监听器调用）。 */
  onSessionEvent(sessionId: string, event: SessionEventLike): void {
    const run = this.active.get(sessionId)
    if (run === undefined) return
    run.handleEvent(event)
  }

  /** 路由 agent/inbox/claimed（把消息 id 关联到 turn）。 */
  onMessageClaimed(sessionId: string, messageId: string, turn: number): void {
    this.active.get(sessionId)?.onMessageClaimed(messageId, turn)
  }

  /** 路由 agent/error（Cordis 层兜底，与 turn/end 去重，§5.4）。 */
  onAgentError(sessionId: string, error: unknown): void {
    this.active.get(sessionId)?.onAgentError(error)
  }

  /** 桥接主动取消一个进行中任务（断连/管理取消）。 */
  cancel(sessionId: string, reason: string): boolean {
    const run = this.active.get(sessionId)
    if (run === undefined) return false
    run.requestCancel(reason)
    return true
  }

  /** 会话当前是否有进行中任务。 */
  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  /** 全部活动任务取消（卸载兜底前调用）。 */
  cancelAll(reason: string): void {
    for (const sessionId of [...this.active.keys()]) {
      this.active.get(sessionId)?.requestCancel(reason)
    }
  }
}

/** 供测试/诊断：判断 reason.kind 是否属于已知终局集合。 */
export function isTerminalEndKind(kind: string): boolean {
  return TERMINAL_END_KINDS.has(kind)
}
