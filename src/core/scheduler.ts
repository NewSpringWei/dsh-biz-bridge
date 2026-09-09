/**
 * 调度器（§7）— 回调响应任务的执行与送达。
 *
 * - 执行扫描：type=callback AND status=queued AND scheduled_at<=now，按
 *   priority/scheduled_at/created_at/id 排序（§7.2）；认领前先按 session 串行
 *   筛选（§5.8：hub/pool 进行中任务 + tasks 表 processing 双查），定点乐观锁
 *   认领，避免“认领-回滚-再认领同一行”的空转。
 * - 会话串行化：同一 session 同时至多一个任务被执行/流式占用（双查防漏）。
 * - 送达状态机（§7.4）：completed → callback_status=pending,next=now →
 *   POST callback_url（callback_timeout）→ succeeded / retrying / exhausted+callback_failed。
 * - 不设任务级时长上限（§1.3/§7.1）：执行中任务只在插件激活时被救援（§7.3）。
 *
 * 定时器由 index.ts 在 ctx.effect 内驱动（pump 重入锁，单泵语义）。
 */

import { parseAgentOverridesLenient } from './agent-options.ts'
import { CwdMismatchError, SessionBusyError } from '../shared/errors.ts'
import { externalSessionId } from '../shared/session-id.ts'
import { nowIso } from './db.ts'
import type { BridgeRuntime } from '../shared/runtime.ts'
import type { RunOutcome, TaskRow } from '../shared/types.ts'

const MAX_DELIVERY_PER_PASS = 32
const MAX_CLAIM_CANDIDATES = 32

interface DeliverResult {
  ok: boolean
  httpStatus?: number
  detail?: string
}

/** 解析 tasks.usage JSON 列；NULL / 非法 JSON 按 null（损坏不阻断回调送达）。 */
function parseStoredUsage(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** 回调调度器：pump() 由外部定时器调用。 */
export class CallbackScheduler {
  /** 执行中的回调任务 id（并发额度计数，§7.1 maxConcurrency）。 */
  private readonly running = new Set<string>()
  /** 送达互斥：同一任务只允许一个在途 POST。 */
  private readonly delivering = new Set<string>()
  private readonly runtime: BridgeRuntime
  private pumping = false

  constructor(runtime: BridgeRuntime) {
    this.runtime = runtime
  }

  get inFlight(): number {
    return this.running.size
  }

  /** 是否还能接收新执行任务。 */
  private hasSlots(): boolean {
    return this.running.size < this.runtime.config.scheduler.maxConcurrency
  }

  /** 会话是否被占用（§5.8：进程内 activity + tasks 表双查）。 */
  private isSessionBusy(sessionId: string, taskId: string): boolean {
    return this.runtime.pool.isBusy(sessionId)
      || this.runtime.hub.isBusy(sessionId)
      || this.runtime.db.hasActiveForSession(sessionId, taskId)
  }

  /**
   * 单轮调度：① 回调送达扫描；② 执行扫描。重入锁保证单泵；
   * 执行任务 fire-and-forget（长任务不阻塞送达与其他任务的并发启动）。
   */
  async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      await this.deliveryPass()
      this.executionPass()
    } catch (error: unknown) {
      this.runtime.logger.error(`scheduler pump failed: ${(error as Error).message}`)
    } finally {
      this.pumping = false
    }
  }

  /** 送达扫描（§7.4）：completed 且 pending/retrying 到期项。 */
  private async deliveryPass(): Promise<void> {
    let delivered = 0
    while (delivered < MAX_DELIVERY_PER_PASS) {
      const row = this.runtime.db.getDeliveryCandidate(nowIso())
      if (row === undefined) break
      if (this.delivering.has(row.id)) break // 在途，下轮再试
      this.delivering.add(row.id)
      delivered++
      this.runtime.fileLogger.info('scheduler', `delivery candidate task=${row.id}`)
      void this.attemptDeliver(row).finally(() => this.delivering.delete(row.id))
    }
  }

  /** 执行扫描：按 session 串行筛选后定点认领，额度内并发执行。 */
  private executionPass(): void {
    let claimed = 0
    while (this.hasSlots() && claimed < MAX_CLAIM_CANDIDATES) {
      const now = nowIso()
      const candidates = this.runtime.db.peekQueuedCallbacks(now, MAX_CLAIM_CANDIDATES)
      if (candidates.length === 0) break
      let chosen: TaskRow | undefined
      for (const candidate of candidates) {
        if (this.running.has(candidate.id)) continue
        if (this.isSessionBusy(candidate.session_id, candidate.id)) continue
        if (this.runtime.db.claimSpecific(candidate.id, now)) {
          chosen = this.runtime.db.getTask(candidate.id)
          break
        }
      }
      if (chosen === undefined) break
      claimed++
      this.running.add(chosen.id)
      void this.executeCallback(chosen)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this.runtime.db.failTask(chosen.id, `回调任务执行异常：${message}`, nowIso())
          this.runtime.db.addLog(chosen.id, 'failed', `回调任务执行异常：${message}`, {}, nowIso())
          this.runtime.logger.error(`callback task ${chosen.id} crashed: ${message}`)
          this.runtime.fileLogger.error('scheduler', `callback task ${chosen.id} crashed: ${message}`)
        })
        .finally(() => {
          this.running.delete(chosen.id)
        })
    }
  }

  /** 执行一个回调任务（§5.5 回调流程）。 */
  private async executeCallback(row: TaskRow): Promise<void> {
    const { db, hub, pool, messageFactory, logger } = this.runtime
    // 认领窗口复核：任务可能在 claim 与执行之间被管理级取消（§6.5.4 竞态）。
    const fresh = db.getTask(row.id)
    if (fresh === undefined || fresh.status !== 'processing') {
      logger.info(`callback task ${row.id} skipped: status changed before execution (${fresh?.status ?? 'gone'})`)
      this.runtime.fileLogger.info('scheduler', `callback task ${row.id} skipped`, { status: fresh?.status ?? 'gone' })
      return
    }
    const agentOptions = parseAgentOverridesLenient(row.params)
    logger.info(`callback task ${row.id} claimed, session=${row.session_id}`)
    this.runtime.fileLogger.info('scheduler', `callback task ${row.id} claimed`, { sessionId: row.session_id, bizId: row.biz_id })

    // openAgent（§5.2.1）。会话忙/配置性错误按执行失败落库，避免队列毒化。
    let agent
    try {
      agent = await pool.openAgent(row.session_id, agentOptions)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const detail = error instanceof SessionBusyError || error instanceof CwdMismatchError
        ? `打开会话失败（${error.name}）：${message}`
        : `打开会话失败：${message}`
      db.failTask(row.id, detail, nowIso())
      db.addLog(row.id, 'failed', detail, { reason: 'openAgent' }, nowIso())
      logger.warn(`callback task ${row.id} openAgent failed: ${message}`)
      this.runtime.fileLogger.warn('scheduler', `callback task ${row.id} openAgent failed: ${message}`)
      return
    }

    db.addLog(row.id, 'processing', '开始执行', { session_id: row.session_id }, nowIso())
    const outcome = await hub.runTurn({
      sessionId: row.session_id,
      taskId: row.id,
      prompt: row.prompt,
      agent,
      messageFactory,
      onAssistantMessage: (turn: number, text: string, usage: Record<string, unknown> | null) => {
        db.addLog(row.id, 'chunk', text, { turn, usage: usage ?? undefined })
      },
    })
    this.settleOutcome(row, outcome)

    // 完成后立即尝试送达（pending 已武装）；失败由送达状态机 + 下轮扫描重试。
    const settledRow = db.getTask(row.id)
    if (settledRow !== undefined && settledRow.status === 'completed' && settledRow.callback_status === 'pending') {
      await this.attemptDeliver(settledRow)
    }
  }

  /** 结局落库（终态守卫：SQL WHERE status 层保证不覆盖并发取消）。 */
  private settleOutcome(row: TaskRow, outcome: RunOutcome): void {
    const { db, fileLogger } = this.runtime
    const now = nowIso()
    if (outcome.kind === 'completed') {
      db.completeTask(row.id, { result: outcome.result, usage: outcome.usage, isCallback: true, now })
      db.addLog(row.id, 'completed', '任务完成', { usage: outcome.usage ?? undefined }, now)
      fileLogger.info('scheduler', `callback task ${row.id} completed`, { usage: outcome.usage ?? undefined })
    } else if (outcome.kind === 'failed') {
      db.failTask(row.id, outcome.message, now)
      db.addLog(row.id, 'failed', outcome.message, { reason: outcome.reason }, now)
      fileLogger.error('scheduler', `callback task ${row.id} failed: ${outcome.message}`)
    } else {
      db.cancelTask(row.id, outcome.message, now, ['processing'])
      db.addLog(row.id, 'cancelled', outcome.message, {}, now)
      fileLogger.info('scheduler', `callback task ${row.id} cancelled: ${outcome.message}`)
    }
  }

  /** POST 一次回调（受 callback_timeout 约束；2xx 即成功，§6.4.3/§7.1）。 */
  private async attemptDeliver(row: TaskRow): Promise<void> {
    const { db, config, logger } = this.runtime
    const callbackUrl = row.callback_url
    if (callbackUrl === null) {
      // 防御：缺 callback_url 的任务不可能送达成功
      const next = db.recordCallbackResult(row.id, {
        ok: false,
        retryCount: row.retry_count + 1,
        maxRetry: config.scheduler.maxRetry,
        retryIntervalSeconds: config.scheduler.retryInterval,
        now: nowIso(),
      })
      db.addLog(row.id, 'callback', `回调缺少 callback_url（状态 ${next}）`, {}, nowIso())
      return
    }
    const payload = this.buildCallbackPayload(row)
    const result = await this.postJson(callbackUrl, payload, config.scheduler.callbackTimeout)
    const attempts = row.retry_count + 1
    const nextStatus = db.recordCallbackResult(row.id, {
      ok: result.ok,
      retryCount: attempts,
      maxRetry: config.scheduler.maxRetry,
      retryIntervalSeconds: config.scheduler.retryInterval,
      now: nowIso(),
    })
    const detail = result.ok
      ? `回调成功（HTTP ${result.httpStatus}）`
      : `回调失败（HTTP ${result.httpStatus ?? 'N/A'}${result.detail !== undefined ? `: ${result.detail}` : ''}），将${nextStatus === 'exhausted' ? '超过重试上限' : '按策略重试'}`
    db.addLog(row.id, 'callback', detail, { attempt: attempts, http_status: result.httpStatus ?? null, next_status: nextStatus }, nowIso())
    logger.info(`callback delivery task=${row.id} attempt=${attempts} ok=${result.ok} next=${nextStatus}`)
    this.runtime.fileLogger.info('scheduler', `callback delivery task=${row.id}`, { attempt: attempts, ok: result.ok, httpStatus: result.httpStatus ?? null, nextStatus })
  }

  /** 组装 §6.4.3 回调体。 */
  private buildCallbackPayload(row: TaskRow): Record<string, unknown> {
    const result = this.runtime.db.getTaskResult(row.id)
    return {
      task_id: row.id,
      biz_id: row.biz_id,
      replay_seq: row.replay_seq,
      session_id: externalSessionId(row.session_id),
      type: 'callback',
      status: 'completed',
      result,
      error_message: null,
      created_at: row.created_at,
      completed_at: row.completed_at,
      usage: parseStoredUsage(row.usage),
    }
  }

  /** 单次 HTTP POST（超时受 callbackTimeout 秒约束；2xx 成功）。 */
  private async postJson(url: string, body: Record<string, unknown>, timeoutSeconds: number): Promise<DeliverResult> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      })
      return { ok: response.ok, httpStatus: response.status }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, detail: message }
    }
  }
}
