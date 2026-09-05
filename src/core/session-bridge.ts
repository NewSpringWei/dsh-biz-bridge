/**
 * 会话桥接层（§5.2）— 与 DSH 无关的结构化实现，便于用 fake gateway 单测。
 *
 * 决策流（§5.2.1）：
 *   a. sessions.get(sessionId) 命中 → 复用本桥接注册表内的 live handle；
 *      活跃但非本桥接持有 → SessionBusyError（不接管，避免订阅未知事件流）。
 *   b. sessionPersistence.stat(sessionId) 命中 → resume 从持久化 log 恢复
 *      （覆盖进程重启、handle 已回收两种场景）；恢复前校验持久化 header 的
 *      cwd 与当前工作目录一致（cwd 校验，§5.2.1）。
 *   c. 全新会话 → create；仅对 already-exists 类错误 fallback 到 resume
 *      （并发兜底），其余错误如实透传。
 * 并发激活去重：同 session 并发 openAgent 复用同一 Promise（等待而非拒绝）。
 *
 * handle 生命周期（§5.2.2）：live 注册表 + 空闲回收（判据：无进行中任务 +
 * 超过 agent.idleTimeout 未见 activity）+ 插件卸载统一 dispose。
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

/** 注册表条目：持有者 handle + 最近 activity 时间。 */
interface OwnedEntry {
  agent: BridgeAgent
  lastActivity: number
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
 * Agent 池：openAgent 决策流 + live handle 注册表 + 并发激活去重 + 空闲回收。
 */
export class AgentPool {
  /** sessionId → 注册表条目。 */
  private readonly handles = new Map<string, OwnedEntry>()
  /** sessionId → 进行中任务占位（§5.8 会话串行 + §5.2.2 回收守卫 ①）。 */
  private readonly activity = new Set<string>()
  /** sessionId → 激活中 Promise（§5.2.1 并发激活去重）。 */
  private readonly activating = new Map<string, Promise<BridgeAgent>>()
  /** 回收判据 ②：超过 idleTimeout（毫秒）未活动即回收。0 = 禁用。 */
  private readonly idleTimeoutMs: number
  private readonly gateway: SessionGateway
  private readonly clock: () => number
  private closed = false

  constructor(gateway: SessionGateway, agentIdleTimeoutMinutes: number, clock: () => number = Date.now) {
    this.gateway = gateway
    this.clock = clock
    this.idleTimeoutMs = agentIdleTimeoutMinutes <= 0 ? 0 : agentIdleTimeoutMinutes * 60_000
  }

  /**
   * openAgent 决策流（§5.2.1）。同 session 并发调用复用同一激活 Promise。
   * @throws SessionBusyError 活跃会话非本桥接持有
   * @throws CwdMismatchError 持久化 cwd 与当前工作目录不一致
   */
  async openAgent(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
    this.assertOpen()
    const owned = this.handles.get(sessionId)
    if (owned !== undefined && this.gateway.liveSessionExists(sessionId)) {
      return owned.agent
    }
    if (owned !== undefined) {
      // 注册表有条目但会话已不活跃（agent 被他方 dispose）——清除陈旧条目。
      this.handles.delete(sessionId)
      void owned.agent.dispose().catch(() => { /* 已销毁，忽略 */ })
    }
    const inflight = this.activating.get(sessionId)
    if (inflight !== undefined) return inflight
    const pending = this.doOpen(sessionId, agentOptions).finally(() => {
      this.activating.delete(sessionId)
    })
    this.activating.set(sessionId, pending)
    return pending
  }

  private async doOpen(sessionId: string, agentOptions?: AgentParamOverrides): Promise<BridgeAgent> {
    this.assertOpen()
    // a. 已有 live agent → 复用；活跃但注册表无记录（部署方自建/撞号）→ 不接管。
    if (this.gateway.liveSessionExists(sessionId)) {
      const owned = this.handles.get(sessionId)
      if (owned !== undefined) return owned.agent
      throw new SessionBusyError(`session "${sessionId}" is active but not owned by this bridge`)
    }
    // b. 有持久化 log → resume（覆盖重启 / 回收）；cwd 校验。
    const persisted = await this.gateway.persistedStat(sessionId)
    if (persisted !== undefined) {
      const persistedCwd = persisted.header?.cwd
      if (persistedCwd !== undefined && persistedCwd !== '') {
        const current = this.gateway.currentCwd()
        if (!await sameDirectory(persistedCwd, current)) {
          throw new CwdMismatchError(sessionId, persistedCwd, current)
        }
      }
      const agent = await this.gateway.resumeAgent(sessionId, agentOptions)
      this.handles.set(sessionId, { agent, lastActivity: this.clock() })
      return agent
    }
    // c. 全新会话 → create；并发兜底仅对 already-exists 错误 fallback。
    try {
      const agent = await this.gateway.createAgent(sessionId, agentOptions)
      this.handles.set(sessionId, { agent, lastActivity: this.clock() })
      return agent
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error)) throw error
      const agent = await this.gateway.resumeAgent(sessionId, agentOptions)
      this.handles.set(sessionId, { agent, lastActivity: this.clock() })
      return agent
    }
  }

  /** 标记会话有进行中任务（§5.8 / 回收守卫 ①）。 */
  beginActivity(sessionId: string): void {
    this.activity.add(sessionId)
  }

  /** 任务结束：移除进行中占位并刷新活动时间（§5.2.2 判据 ②）。 */
  endActivity(sessionId: string): void {
    this.activity.delete(sessionId)
    const owned = this.handles.get(sessionId)
    if (owned !== undefined) owned.lastActivity = this.clock()
  }

  /** 刷新活动时间（收到 session 事件 / 任务完成时调用）。 */
  touch(sessionId: string): void {
    const owned = this.handles.get(sessionId)
    if (owned !== undefined) owned.lastActivity = this.clock()
  }

  /** 是否有进行中任务（供流式 409 / 调度器会话串行查询）。 */
  isBusy(sessionId: string): boolean {
    return this.activity.has(sessionId)
  }

  /** 注册表当前是否持有该会话的 live handle。 */
  owns(sessionId: string): boolean {
    return this.handles.has(sessionId)
  }

  /**
   * 空闲回收扫描（§5.2.2）：判据同时满足——① 无进行中任务；② agent 不在运行
   * （防止回收被部署方驱动中的会话）；③ 最近一次 activity 距今超过 idleTimeout。
   * 先原子摘除注册表再 dispose；下次请求经路径 b resume 恢复，上下文不丢。
   */
  reapIdle(): Array<{ sessionId: string; agent: BridgeAgent }> {
    if (this.idleTimeoutMs === 0) return []
    const now = this.clock()
    const reaped: Array<{ sessionId: string; agent: BridgeAgent }> = []
    for (const [sessionId, entry] of this.handles) {
      if (this.activity.has(sessionId)) continue
      if (!entry.agent.idle) continue
      if (now - entry.lastActivity < this.idleTimeoutMs) continue
      this.handles.delete(sessionId)
      reaped.push({ sessionId, agent: entry.agent })
    }
    for (const item of reaped) {
      void item.agent.dispose().catch(() => { /* 回收失败仅记录；下次 openAgent 会重试 */ })
    }
    return reaped
  }

  /** 会话被外部 dispose（agent/disposed 事件）：清注册表陈旧条目。 */
  pruneDisposed(sessionId: string): void {
    if (!this.handles.has(sessionId)) return
    this.handles.delete(sessionId)
    this.activity.delete(sessionId)
  }

  /** 当前持有数（诊断用）。 */
  size(): number {
    return this.handles.size
  }

  /** 插件卸载：取消全部 activity 并 dispose 全部 handle（§5.2.2）。 */
  async disposeAll(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const entries = [...this.handles.values()]
    this.handles.clear()
    this.activity.clear()
    await Promise.allSettled(entries.map(entry => entry.agent.dispose()))
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('dsh-biz-bridge: agent pool is disposed')
  }
}
