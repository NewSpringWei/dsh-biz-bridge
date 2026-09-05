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
 * 注：设计 §5.1 的注入清单不含 `timer`（host 侧无此服务，§8.2 patch 注释），
 * 定时调度由 index.ts 在 ctx.effect 内用 setInterval 实现。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { BridgeAgent, SessionGateway } from '../core/session-bridge.ts'
import type { AgentParamOverrides, TextMessageFactory, TextUserMessage } from '../shared/types.ts'

/** AgentHandle → 桥接 agent 面（取消原因统一走 hook，供断连/管理取消识别）。 */
function toBridgeAgent(handle: AgentHandle): BridgeAgent {
  const agent = handle.agent
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
    dispose(): Promise<void> {
      return handle.dispose()
    },
  }
}

/** 用注入服务构造真实会话网关。 */
export function createSessionGateway(ctx: Context): SessionGateway {
  return {
    liveSessionExists(sessionId: string): boolean {
      return ctx.sessions.get(SessionId(sessionId)) !== undefined
    },
    async persistedStat(sessionId: string) {
      const snapshot = await ctx.sessionPersistence.stat(SessionId(sessionId))
      return snapshot === undefined ? undefined : { header: snapshot.header }
    },
    currentCwd(): string {
      return process.cwd()
    },
    async createAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
      const handle = await ctx.agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: process.cwd() },
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
