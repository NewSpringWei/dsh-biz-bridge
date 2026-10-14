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
import { CwdMismatchError, isAlreadyExistsError } from '../shared/errors.ts'
import type { AgentParamOverrides, UserMessageLike } from '../shared/types.ts'

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
  /** 追加一轮用户消息并唤醒 driver（§5.3；content 可含图片/文件块）。 */
  followup(message: UserMessageLike): void
  /** 桥接主动取消当前 turn（内部包装 cause={kind:'hook', reason}）。 */
  cancel(reason: string): void
  /** 等待 agent 活动收敛（§5.5）。 */
  whenIdle(): Promise<void>
  /** 结束 agent 生命周期（dispose）。 */
  dispose(): Promise<void>
}

/** 会话网关（gateway.ts 实现；测试用 fake）。 */
export interface SessionGateway {
  /**
   * a. live agent 复用：会话已有 live agent 时返回其桥接面（agents.get，不重开
   *    持久写句柄）；否则返回 undefined，由决策流继续 stat/resume/create。
   */
  liveAgent(sessionId: string): BridgeAgent | undefined
  /** b. 持久化 session log 探测（ctx.sessionPersistence.stat）。 */
  persistedStat(sessionId: string): Promise<PersistedSessionProbe | undefined>
  /**
   * 某 session 的期望工作目录（per-client workspace，runtime/workspace/<clientId>）。
   * create 时作为 meta.cwd；resume 前与持久化 header.cwd 做一致性校验。
   */
  workspaceOf(sessionId: string): string
  /** c. create 新会话；meta.cwd = workspaceOf(sessionId)（实现方负责确保目录存在）。 */
  createAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent>
  /** b. resume 已持久化会话（仅无 live agent 时调用）。 */
  resumeAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent>
  /**
   * 把本轮的**会话级模型选择**装到 agent 上（§5.2.2）。
   *
   * 为什么 `createAgent`/`resumeAgent` 的 `agentOptions` 不够：那是 **agent 实例级**的，
   * 只在创建/恢复那一刻进 DSH（`AgentOptions.provider/model` 被实例持有）。而 live agent
   * 会被复用（路径 a）、桥接又从不主动销毁它 —— 于是后续请求的 `agentOptions` 被静默丢弃，
   * 表现为"一个会话的模型第一次用哪个就定死了"，只有换会话 id 才能换模型。
   *
   * 会话级选择装在 agent 自己的作用域上，DSH 每步请求重新解析（`system-prompt/assemble`
   * → `agent/request`），所以同一会话内换模型立即生效，且**对话记忆不丢**（会话日志未变）。
   * 与 DSH 官方 `selectModel` 走的是同一条机制，区别只是入口在桥接的 `params` 而不是 GUI。
   * @param agent - 本轮要用的 agent（live / 恢复 / 新建都走这里）。
   * @param sessionId - 会话身份；选择按会话归属、跨请求保持。
   * @param selection - 本轮显式指定的 agent 覆盖项；`provider` 与 `model` **不成对时保持上次的选择**
   *   （单给一个 DSH 会直接报 `agent has no provider/model`，形状校验在 ops 层已做过）。
   */
  applyModelSelection(agent: BridgeAgent, sessionId: string, selection?: AgentParamOverrides): void
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
   * @throws CwdMismatchError 持久化 cwd 与该 session 的期望工作目录（per-client workspace）不一致
   */
  async openAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
    this.assertOpen()
    /**
     * 每条返回路径的收尾：把本轮模型选择应用上（§5.2.2）。
     *
     * **live 复用这条路径尤其不能漏** —— 它正是"换了模型不生效"的来源：
     * 实例级 `agentOptions` 只在 create/resume 进 DSH，复用 live agent 时无处可去。
     * 收成一个局部函数，是为了让"返回 agent"与"应用选择"在四条路径上不可能走散。
     */
    const applied = (agent: BridgeAgent): BridgeAgent => {
      this.gateway.applyModelSelection(agent, sessionId, agentOptions)
      return agent
    }
    // a. 已有 live agent → 直接复用（agents.get；绝不 resume——resume 会与 live
    //    会话持有的持久写句柄冲突：already owned by an active write handle）。
    const live = this.gateway.liveAgent(sessionId)
    if (live !== undefined) return applied(live)
    // b. 有持久化 log → resume；cwd 校验（期望 = 该 session 所属 client 的 workspace）。
    const persisted = await this.gateway.persistedStat(sessionId)
    if (persisted !== undefined) {
      const persistedCwd = persisted.header?.cwd
      if (persistedCwd !== undefined && persistedCwd !== '') {
        const expected = this.gateway.workspaceOf(sessionId)
        if (!await sameDirectory(persistedCwd, expected)) {
          throw new CwdMismatchError(sessionId, persistedCwd, expected)
        }
      }
      return applied(await this.gateway.resumeAgent(sessionId, agentOptions))
    }
    // c. 全新会话 → create；并发兜底仅对 already-exists 错误 fallback。
    try {
      return applied(await this.gateway.createAgent(sessionId, agentOptions))
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error
      return applied(await this.gateway.resumeAgent(sessionId, agentOptions))
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
