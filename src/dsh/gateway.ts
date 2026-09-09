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
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { clientWorkspaceDir } from '../config/config.ts'
import type { BridgeAgent, SessionGateway } from '../core/session-bridge.ts'
import type { AgentParamOverrides, TextMessageFactory, TextUserMessage } from '../shared/types.ts'

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
    followup(message: TextUserMessage): void {
      agent.followup(message as UserMessage)
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
 */
export function createSessionGateway(ctx: Context, workspaceDir: string): SessionGateway {
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
      return toBridgeAgent(handle)
    },
    async resumeAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
      const handle = await ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
      return toBridgeAgent(handle)
    },
  }
}

/** 真实文本消息工厂（§5.3 createUserMessage）。 */
export function createTextMessageFactory(): TextMessageFactory {
  return (text: string): TextUserMessage =>
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }) as TextUserMessage
}
