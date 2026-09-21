/**
 * DSH 进程内网关（§5.1/§5.2）——把注入的 DSH 服务适配为 session-bridge /
 * runner 所需的结构化面。仅本文件 import @deepseek-ai 运行时模块。
 *
 * 真实服务：
 * - ctx.sessions（内存 store 活跃查询，路径 a）
 * - ctx.sessionPersistence（持久化探测 stat，路径 b）
 * - ctx.agents（create / resume，返回 AgentHandle）
 * - 消息构造用 @deepseek-ai/dsh-llm 的 createUserMessage（§5.3）
 *
 * 事件解码（session/event → 归一化 TurnEvent）在 ./decode.ts：零 DSH 依赖、
 * 可单测；官方事件模型变更只改该文件，本网关与 runner 均不动。
 *
 * 注：设计 §5.1 的注入清单不含 `timer`（host 侧无此服务，§8.2 patch 注释），
 * 定时调度由 index.ts 在 ctx.effect 内用 setInterval 实现。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { clientWorkspaceDir } from '../config/config.ts'
import { NotImplementedError } from '../shared/errors.ts'
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
 * AgentHandle.agent / agents.get 返回的 live Agent → 桥接 agent 面。
 * 取消原因统一走 hook（供断连/管理取消识别）。
 */
function toAgentBridge(agent: AgentHandle['agent']) {
  return {
    id: agent.session.id,
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
 */
export function createSessionGateway(
  ctx: Context,
  workspaceDir: string,
  onAgentScope?: (agent: { ctx: Context; session: AgentHandle['agent']['session'] }, sessionId: string) => void,
): SessionGateway {
  /** 某 session 的期望工作目录：runtime/workspace/<clientId>（业务隔离边界）。 */
  const workspaceOf = (sessionId: string): string =>
    clientWorkspaceDir(workspaceDir, clientOfSession(sessionId))

  return {
    liveAgent(sessionId: string): BridgeAgent | undefined {
      // live 复用必须走 agents.get：DSH 0.1.5 中 resume() 会尝试持久写句柄独占，
      // 而 live agent 仍持有该句柄 → 直接 resume 会抛 already owned。生命周期由
      // DSH 管理，复用方不持有 dispose（置空实现，绝不主动销毁 DSH 的 agent）。
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
