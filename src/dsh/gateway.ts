/**
 * DSH 进程内网关（§5.1/§5.2）——把注入的 DSH 服务适配为 session-bridge /
 * runner 所需的结构化面。仅本文件 import @deepseek-ai 运行时模块。
 *
 * 真实服务：
 * - ctx.sessions（内存 store 活跃查询，路径 a）
 * - ctx.sessionPersistence（持久化探测 stat，路径 b）
 * - ctx.agents（create / resume，返回 AgentHandle）
 * - 会话级模型选择（§5.2.2）：经 `installModelSelection` 装在 agent 自己的作用域上，
 *   每步请求重新解析 —— 这是"同一会话内换模型"能生效的唯一通道（实例级 `AgentOptions` 不够）
 * - 消息构造用 @deepseek-ai/dsh-llm 的 createUserMessage（§5.3）
 *
 * 事件解码（session/event → 归一化 TurnEvent）在 ./decode.ts：零 DSH 依赖、
 * 可单测；官方事件模型变更只改该文件，本网关与 runner 均不动。
 *
 * 注：设计 §5.1 的注入清单不含 `timer`（host 侧无此服务，§8.2 patch 注释），
 * 定时调度由 index.ts 在 ctx.effect 内用 setInterval 实现。
 */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { clientWorkspaceDir } from '../config/config.ts'
import { NotImplementedError } from '../shared/errors.ts'
import { modelSelectionInstallLog, modelSwitchLog, type SessionModelSelection } from '../core/model-selection.ts'
import type { BridgeAgent, SessionGateway } from '../core/session-bridge.ts'
import type { AttachmentAdmissionPort } from '../core/attachments.ts'
import type {
  AgentParamOverrides, FileAttachmentRefLike, ImageAttachmentRefLike, UserContentBlock, UserMessageFactory, UserMessageLike,
} from '../shared/types.ts'

export { decodeSessionEvent, extractTextContent, unfoldStream } from './decode.ts'
export type { SessionEventLike } from './decode.ts'

/**
 * 内部 session id（clientId:type:sessionId 三段式）→ 所属业务 client。
 * clientId 由 wire 校验（^[A-Za-z0-9_-]{1,128}$）不含冒号，取首段即可靠。
 */
function clientOfSession(sessionId: string): string {
  const colon = sessionId.indexOf(':')
  const clientId = colon < 0 ? sessionId : sessionId.slice(0, colon)
  if (clientId === '') {
    throw new Error(`dsh-biz-bridge: cannot derive client workspace from session id "${sessionId}"`)
  }
  return clientId
}

/**
 * 包装对象 → 真实 DSH Agent 的私有通道。
 *
 * 为什么需要它：`liveAgent()` **每次调用都重新包装**同一个真实 agent，所以包装对象当不了
 * 幂等键；而会话级模型选择只能给同一个真实 agent 装一次 —— 重复装会注册多份
 * `agent/request` listener，模型被叠加覆盖。
 */
const RAW_AGENT = Symbol('dsh-biz-bridge.rawAgent')
/** 带私有通道的桥接 agent 面（只有本文件读它）。 */
type BridgedAgent = BridgeAgent & { readonly [RAW_AGENT]?: AgentHandle['agent'] }

/**
 * AgentHandle.agent / agents.get 返回的 live Agent → 桥接 agent 面。
 * 取消原因统一走 hook（供断连/管理取消识别）。
 */
function toAgentBridge(agent: AgentHandle['agent']) {
  return {
    id: agent.session.id,
    [RAW_AGENT]: agent,
    get idle(): boolean {
      return agent.status === 'idle'
    },
    followup(message: UserMessageLike): void {
      agent.followup(message as unknown as UserMessage)
    },
    cancel(reason: string): void {
      agent.cancel({ kind: 'hook', reason })
    },
    whenIdle(): Promise<void> {
      return agent.whenIdle()
    },
  }
}

/** AgentHandle（创建/恢复路径持有者）→ 桥接 agent 面（含 dispose 能力）。 */
function toBridgeAgent(handle: AgentHandle): BridgeAgent {
  return {
    ...toAgentBridge(handle.agent),
    dispose(): Promise<void> {
      return handle.dispose()
    },
  }
}

/**
 * 用注入服务构造真实会话网关。
 * @param ctx - 插件上下文
 * @param workspaceDir - runtime/workspace 根目录；每个 client 一个子目录作为其会话 cwd
 * @param onAgentScope - 可选：在**新建/恢复的 agent 自己的作用域**上应用安全策略
 *   （系统提示词段落、工具限制、会话沙箱模式）。在首次投递前调用，保证策略对模型的
 *   首个请求即生效。
 * @param log - 可选：会话级模型选择的日志出口（§5.2.3）。**只在选择首次建立或真的变化时**
 *   调用 —— 每轮都写会把真正的切换埋掉（判定与文案见 `core/model-selection.ts`）。
 */
export function createSessionGateway(
  ctx: Context,
  workspaceDir: string,
  onAgentScope?: (agent: { ctx: Context; session: AgentHandle['agent']['session'] }, sessionId: string) => void,
  log?: (message: string) => void,
): SessionGateway {
  /** 某 session 的期望工作目录：runtime/workspace/<clientId>（业务隔离边界）。 */
  const workspaceOf = (sessionId: string): string =>
    clientWorkspaceDir(workspaceDir, clientOfSession(sessionId))

  /**
   * sessionId → 会话级模型选择（跨请求保持）。
   * 与 DSH `ModelSelectionRef` 同形：桥接只写 `current`（调用方显式指定的模型），
   * `assembled` 由 DSH 在每步提示词组装时快照，不归桥接管。
   */
  const modelSelections = new Map<string, ModelSelectionRef>()
  /** 已装过选择的真实 agent（幂等键见 `RAW_AGENT`）。 */
  const selectionInstalled = new WeakSet<object>()

  /**
   * 把本轮模型选择装到 agent 上（§5.2.2）。
   *
   * 只写成 `current` 而不动 DSH 的任何内部状态：每步请求 DSH 自己会把
   * `system-prompt/assemble` 的快照应用到 `agent/request`，并在路由变化时往会话追加
   * 一条"model changed"通告 —— 所以这里不需要、也不应该自己拼提示词。
   */
  function applyModelSelection(agent: BridgeAgent, sessionId: string, selection?: AgentParamOverrides): void {
    const raw = (agent as BridgedAgent)[RAW_AGENT]
    if (raw === undefined) {
      throw new Error('dsh-biz-bridge: agent was not built by this gateway; cannot apply model selection')
    }
    let ref = modelSelections.get(sessionId)
    if (ref === undefined) {
      ref = { current: undefined, assembled: undefined }
      modelSelections.set(sessionId, ref)
    }
    // 只有成对给出才更新：单给一个 DSH 会报 `agent has no provider/model`（形状校验见 ops.ts），
    // 不成对时**保持上次的选择**而不是清掉 —— 会话级选择本来就该跨请求延续。
    if (selection?.provider !== undefined && selection.model !== undefined) {
      const next: SessionModelSelection = {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      }
      // **变了才记**（判定与文案见 core/model-selection.ts）：这行是"换了模型到底有没有生效"
      // 的第一手证据；每轮请求都写一条，真正的切换就淹在噪声里了。
      const switched = modelSwitchLog(sessionId, ref.current, next)
      if (switched !== undefined) log?.(switched)
      ref.current = {
        provider: next.provider,
        model: next.model,
        ...next.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(next.reasoningEffort) },
      }
    }
    if (selectionInstalled.has(raw)) return
    selectionInstalled.add(raw)
    // listener 挂在 agent 自己的作用域上，agent 销毁时随之释放；桥接不持有 disposer。
    installModelSelection(raw.ctx, ref)
    // 装载本身也记一条：它区分"选择刚建立"和"选择在既有会话上生效"，
    // 排查"换了模型没反应"时第一眼看的就是它有没有出现。
    log?.(modelSelectionInstallLog(sessionId, ref.current))
  }

  return {
    applyModelSelection,
    liveAgent(sessionId: string): BridgeAgent | undefined {
      // live 复用必须走 agents.get：DSH 0.1.5 起 resume() 会尝试持久写句柄独占
      // （0.1.7 仍如此），而 live agent 仍持有该句柄 → 直接 resume 会抛 already owned。
      // 生命周期由 DSH 管理，复用方不持有 dispose（置空实现，绝不主动销毁 DSH 的 agent）。
      const agent = ctx.agents.get(SessionId(sessionId))
      if (agent === undefined) return undefined
      return {
        ...toAgentBridge(agent),
        dispose(): Promise<void> { return Promise.resolve() },
      }
    },
    async persistedStat(sessionId: string) {
      const snapshot = await ctx.sessionPersistence.stat(SessionId(sessionId))
      return snapshot === undefined ? undefined : { header: snapshot.header }
    },
    workspaceOf,
    async createAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
      const cwd = workspaceOf(sessionId)
      // 惰性确保该 client 的工作区目录存在（stream 立即开 agent / 调度器回调执行均经此路径）
      mkdirSync(cwd, { recursive: true })
      const handle = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd },
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
      onAgentScope?.(handle.agent, sessionId)
      return toBridgeAgent(handle)
    },
    async resumeAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
      const handle = await ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
      onAgentScope?.(handle.agent, sessionId)
      return toBridgeAgent(handle)
    },
  }
}

/**
 * 真实用户消息工厂（§5.3 createUserMessage）。
 * @param content 文本与入站附件块（图片/文件引用由附件准入端口产出）
 * @returns 冻结的用户消息
 */
export function createUserMessageFactory(): UserMessageFactory {
  return (content: UserContentBlock[]): UserMessageLike =>
    createUserMessage({
      // 结构兼容：图片/文件引用就是 DSH 附件服务返回的对象，只有 attachmentId 的
      // 品牌类型在结构镜像里退化为 string，故此处做一次断言。
      content: content as unknown as ContentBlock[],
      source: { kind: 'user' },
    }) as unknown as UserMessageLike
}

/**
 * 附件服务的结构面（只用到图片/文件两个保存方法）。
 * 不直接 import @deepseek-ai/dsh-attachment：宿主不一定挂载该服务，且此处只需结构一致。
 */
interface AttachmentStoreLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<ImageAttachmentRefLike>
  saveFile(input: { data: Uint8Array; name?: string }): Promise<FileAttachmentRefLike>
}

/**
 * DSH 附件准入端口（§6.4.4）：把已落盘的字节提升为持久引用。
 *
 * 服务缺失（宿主 profile 未挂载 attachments）时抛可读错误——只影响带附件的请求，
 * 纯文本路径不受影响，因此 attachments 不进入 inject 强依赖清单。
 */
export function createAttachmentAdmission(ctx: Context): AttachmentAdmissionPort {
  const store = (): AttachmentStoreLike => {
    const service = ctx.get('attachments') as AttachmentStoreLike | undefined
    if (service === undefined) {
      throw new NotImplementedError('attachment service is not mounted in this host profile')
    }
    return service
  }
  return {
    async admitImage(input): Promise<ImageAttachmentRefLike> {
      return await store().saveImage({ data: input.data, mediaType: input.mediaType, name: input.name })
    },
    async admitFile(input): Promise<FileAttachmentRefLike> {
      return await store().saveFile({ data: input.data, name: input.name })
    },
  }
}
