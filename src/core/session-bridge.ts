/**
 * 会话桥接层（§5.2）— 与 DSH 无关的结构化实现，便于用 fake gateway 单测。
 *
 * 职责精简为两项：
 *   1. openAgent 决策流：live session → resume → create，由 DSH 管理 agent 生命周期；
 *   2. 会话并发守卫：activity Set 追踪"正在处理任务的 session"，供流式 409 和调度器串行用。
 *
 * 不缓存 agent、不 dispose、不回收——agent 的生命周期完全交由 DSH 管理。
 */

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { CwdMismatchError, SessionBusyError, isAlreadyExistsError } from '../shared/errors.ts'
import type { AgentParamOverrides, TextUserMessage } from '../shared/types.ts'

/** gateway 暴露的持久化探测快照（仅消费 header.cwd）。 */
export interface PersistedSessionProbe {
  header?: { cwd?: string }
}

/** 桥接视角的 agent 最小面（真实 Agent 的结构子集，由 gateway 适配）。 */
export interface BridgeAgent {
  /** 会话标识（= agent/session 的 id）。 */
  readonly id: string
  /** 当前是否空闲（agent.status === 'idle'）。 */
  readonly idle: boolean
  /** 追加一轮用户消息并唤醒 driver（§5.3）。 */
  followup(message: TextUserMessage): void
  /** 桥接主动取消当前 turn（内部包装 cause={kind:'hook', reason}）。 */
  cancel(reason: string): void
  /** 等待 agent 活动收敛（§5.5）。 */
  whenIdle(): Promise<void>
  /** 结束 agent 生命周期（dispose）。 */
  dispose(): Promise<void>
}

/** 会话网关（gateway.ts 实现；测试用 fake）。 */
export interface SessionGateway {
  /** a. 内存 store 中是否有 live session（ctx.sessions.get）。 */
  liveSessionExists(sessionId: string): boolean
  /** b. 持久化 session log 探测（ctx.sessionPersistence.stat）。 */
  persistedStat(sessionId: string): Promise<PersistedSessionProbe | undefined>
  /** 当前工作目录（create meta 与 cwd 校验用）。 */
  currentCwd(): string
  /** c. create 新会话；meta.cwd = currentCwd()。 */
  createAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent>
  /** b. resume 已持久化会话。 */
  resumeAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent>
}

/** 目录物理等值比较（同 realpath；解析失败回退词法，对齐 ACP sameDirectory）。 */
export async function sameDirectory(left: string, right: string): Promise<boolean> {
  if (left === undefined || right === undefined) return false
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch {
    return resolve(left) === resolve(right)
  }
}

/**
 * Agent 池：openAgent 决策流 + 会话并发守卫。
 *
 * 不管理 agent 生命周期——每次 openAgent 走 gateway 的 create/resume，
 * 由 DSH 内部决定是否复用已有 agent 或创建新的。
 * activity Set 仅追踪"正在处理任务的 session"，供外部查询 isBusy。
 */
export class AgentPool {
  /** sessionId → 进行中任务占位（会话串行守卫）。 */
  private readonly activity = new Set<string>()
  private readonly gateway: SessionGateway
  private closed = false

  constructor(gateway: SessionGateway) {
    this.gateway = gateway
  }

  /**
   * openAgent 决策流：live → resume → create。
   * 每次都走 gateway，由 DSH 内部决定 agent 复用。
   * @throws SessionBusyError 活跃会话非本桥接持有
   * @throws CwdMismatchError 持久化 cwd 与当前工作目录不一致
   */
  async openAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
    this.assertOpen()
    // a. 已有 live session → 复用；活跃但非本桥接持有 → 不接管。
    if (this.gateway.liveSessionExists(sessionId)) {
      const agent = await this.gateway.resumeAgent(sessionId, agentOptions)
      return agent
    }
    // b. 有持久化 log → resume；cwd 校验。
    const persisted = await this.gateway.persistedStat(sessionId)
    if (persisted !== undefined) {
      const persistedCwd = persisted.header?.cwd
      if (persistedCwd !== undefined && persistedCwd !== '') {
        const current = this.gateway.currentCwd()
        if (!await sameDirectory(persistedCwd, current)) {
          throw new CwdMismatchError(sessionId, persistedCwd, current)
        }
      }
      return await this.gateway.resumeAgent(sessionId, agentOptions)
    }
    // c. 全新会话 → create；并发兜底仅对 already-exists 错误 fallback。
    try {
      return await this.gateway.createAgent(sessionId, agentOptions)
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error
      return await this.gateway.resumeAgent(sessionId, agentOptions)
    }
  }

  /** 标记会话有进行中任务（会话串行守卫）。 */
  beginActivity(sessionId: string): void {
    this.activity.add(sessionId)
  }

  /** 任务结束：移除进行中占位。 */
  endActivity(sessionId: string): void {
    this.activity.delete(sessionId)
  }

  /** 是否有进行中任务（供流式 409 / 调度器会话串行查询）。 */
  isBusy(sessionId: string): boolean {
    return this.activity.has(sessionId)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('dsh-biz-bridge: agent pool is disposed')
  }
}
