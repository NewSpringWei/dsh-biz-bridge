/**
 * Turn 驱动器与事件归约（§5.5 通用执行内核）——结构化实现，供流式/回调两路
 * executor 复用；对齐 DSH 0.1.5（会话日志 v3）流模型。
 *
 * 本模块是 **DSH 无关的归约内核**：消费的是归一化 TurnEvent（dsh/decode.ts
 * 把 DSH 的 session/event 载荷翻译成该协议），不再出现任何 DSH 事件名/载荷
 * 结构——官方事件模型变更只需改 decode.ts 适配层，本模块与其余业务代码不动。
 *
 * 事件流向：DSH 的 session/event 由 index.ts 的全局监听器收到 → decode.ts
 * 归一化为 TurnEvent 序列 → 按 sessionId 路由到本 hub；hub 内同一 session
 * 同时至多一个 ActiveRun（§5.8 会话串行化保证）。agent/inbox/claimed 与
 * agent/error 仍由 index.ts 直接路由（二者载荷在 DSH 0.1.5 未变）。
 *
 * 归约语义（§5.4/§5.5/§9）：
 * - result = 本任务 turn 内全部 assistant 文本（text-delta 与 assistant-message
 *   按序去重拼接，reasoning 不入）；
 * - usage = 本 turn 最后一条 assistant/message 的 usage；
 * - 成败以本 turn 的 turn/end reason.kind 判定；agent/error 兜底去重；
 * - bridge 主动 cancel（断连/管理取消）→ cancelled。
 */

import type { RunOutcome, TextMessageFactory, TextUserMessage } from '../shared/types.ts'

export type { TextMessageFactory, TextUserMessage }

/** turn/end reason 的 JSON 安全视图（DSH LlmFailure/TurnEndReason 的结构子集）。 */
export interface TurnEndReasonLike {
  kind: string
  reason?: Record<string, unknown>
  error?: { message?: string; code?: string } | null
}

/**
 * 归一化 Turn 事件（decode.ts 从 DSH session/event 翻译而来，本协议自解释、
 * 与 DSH 版本解耦）：
 * - 'text-delta' / 'reasoning-delta'：assistant 流式增量（由 v3 内嵌 stream
 *   记录展开，或旧版逐 chunk 事件直译）；
 * - 'assistant-message'：一条已提交的 assistant 消息（全文 + usage）；
 * - 'turn-end'：turn 收尾（成败判定依据）。
 */
export type TurnEvent =
  | { type: 'text-delta'; turn: number; text: string }
  | { type: 'reasoning-delta'; turn: number; text: string }
  | { type: 'assistant-message'; turn: number; text: string; usage: Record<string, unknown> | null }
  | { type: 'turn-end'; turn: number; reason: TurnEndReasonLike }

/** 可驱动 agent 的最小面（真实 Agent 由 gateway 适配）。 */
export interface DriveableAgent {
  readonly id: string
  followup(message: TextUserMessage): void
  /** 桥接主动取消（内部包装 cause={kind:'hook',reason}）。 */
  cancel(reason: string): void
  whenIdle(): Promise<void>
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

  handleEvent(event: TurnEvent): void {
    const inOurTurn = this.turn === undefined || event.turn === this.turn
    switch (event.type) {
      case 'text-delta': {
        if (!inOurTurn) return
        this.collected += event.text
        this.hasTextDelta = true
        this.config.onTextDelta?.(event.text)
        return
      }
      case 'reasoning-delta': {
        if (!inOurTurn) return
        // 思考型模型的推理过程，作为 reasoning 事件转发（不入 result）
        this.config.onReasoningDelta?.(event.text)
        return
      }
      case 'assistant-message': {
        if (!inOurTurn) return
        if (event.usage !== null) this.usage = event.usage
        if (event.text !== '') {
          this.config.onAssistantMessage?.(event.turn, event.text, this.usage)
          // 兜底：若该消息没有伴随 text-delta（纯推理模型、流记录缺失或 DSH
          // 版本差异），在此推送最终文本并收集到 result 中。
          if (!this.hasTextDelta) {
            this.collected += event.text
            this.config.onTextDelta?.(event.text)
          }
        }
        return
      }
      case 'turn-end': {
        if (!inOurTurn) return
        this.reason = event.reason
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
  /**
   * 已占位、尚未进入 active 的会话（§5.8 会话串行）。
   *
   * 用于消除"预检通过 → runTurn 标记 active"之间的并发窗口：`reserve()` 是同步
   * check-and-set，在 Node 单线程下与预检构成原子操作，因此同一会话的第二个并发
   * 请求必然被拒（409 SESSION_BUSY），而不会走到 openAgent 撞上 DSH 的写句柄
   * （`already owned by an active write handle`）而报 500。
   */
  private readonly reserved = new Set<string>()
  private readonly activity: ActivityController

  constructor(activity: ActivityController) {
    this.activity = activity
  }

  /**
   * 原子占位。返回 false 表示该会话已有进行中任务或已被占位。
   * 必须与 `release()` 配对（放 finally），否则会话会被永久卡住。
   */
  reserve(sessionId: string): boolean {
    if (this.active.has(sessionId) || this.reserved.has(sessionId)) return false
    this.reserved.add(sessionId)
    return true
  }

  /** 释放占位。 */
  release(sessionId: string): void {
    this.reserved.delete(sessionId)
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
    onReasoningDelta?: (text: string) => void
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
      onReasoningDelta: input.onReasoningDelta,
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

  /** 路由归一化 Turn 事件（index.ts 经 decode.ts 解码后调用）。 */
  onSessionEvent(sessionId: string, event: TurnEvent): void {
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

  /** 会话当前是否有进行中任务（含"已占位但尚未开跑"的窗口）。 */
  isBusy(sessionId: string): boolean {
    return this.active.has(sessionId) || this.reserved.has(sessionId)
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
