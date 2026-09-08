/**
 * 数据存储层（§4）— node:sqlite（DatabaseSync 同步 API）。
 *
 * - 单文件 SQLite，WAL + busy_timeout；表结构/索引/日志见 §4.2/§4.3。
 * - tasks 兼作消息队列：status 表达执行状态，callback_status/next_callback_at
 *   独立表达回调送达状态（两轴分离，§7.4）。
 * - 时间戳统一存 ISO-8601 UTC 字符串（new Date().toISOString()），
 *   等宽格式下字典序即时间序。
 * - 幂等键 UNIQUE(client_id, biz_id, replay_seq)：并发/重复插入映射为
 *   DuplicateBizIdError（§6.3.1 幂等 409 闭环）。
 *
 * 本模块只依赖 Node 内置模块，可单元测试（:memory:）。
 */

import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DuplicateBizIdError, InvalidRequestError } from '../shared/errors.ts'
import type { CallbackStatus, TaskLogRow, TaskRow, TaskStatus, TaskType } from '../shared/types.ts'

/** 数据库打开选项。 */
export interface BridgeDbOptions {
  /** 文件路径或 ':memory:'；相对路径按 DSH 进程 cwd 解析（设计 §4.1）。 */
  path: string
  journalMode: string
  busyTimeout: number
}

/** ISO 时间工具：nowIso()。 */
export function nowIso(): string {
  return new Date().toISOString()
}

/** 把相对数据库路径解析为绝对路径（':memory:' 除外）。 */
export function resolveDbPath(path: string): string {
  if (path === ':memory:') return path
  return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

interface DbConnection {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: Array<string | number | null>): { changes: number; lastInsertRowid: number | bigint }
    get(...params: Array<string | number | null>): Record<string, unknown> | undefined
    all(...params: Array<string | number | null>): Array<Record<string, unknown>>
  }
}

const VALID_STATUSES: readonly TaskStatus[] = [
  'queued', 'received', 'processing', 'completed', 'failed', 'callback_failed', 'cancelled',
]
const VALID_CALLBACK_STATUSES: readonly CallbackStatus[] = ['pending', 'retrying', 'succeeded', 'exhausted']

/** 数据库句柄：封装 schema、事务与全部任务/日志原语。 */
export class BridgeDb {
  private readonly conn: DbConnection

  constructor(options: BridgeDbOptions) {
    const resolved = resolveDbPath(options.path)
    if (resolved !== ':memory:') {
      mkdirSync(dirname(resolved), { recursive: true })
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- node:sqlite 无默认导出类型
    const module = DatabaseSync as unknown as new (path: string) => DbConnection
    this.conn = new module(resolved)
    this.conn.exec(`PRAGMA journal_mode = ${options.journalMode}`)
    this.conn.exec(`PRAGMA busy_timeout = ${options.busyTimeout}`)
    this.migrate()
  }

  /** 关闭数据库连接。 */
  close(): void {
    const closer = this.conn as unknown as { close(): void }
    closer.close()
  }

  /** 幂等建表 + 索引（§4.2/§4.3）。 */
  private migrate(): void {
    this.conn.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id               TEXT PRIMARY KEY,
        client_id        TEXT NOT NULL,
        biz_id           TEXT NOT NULL,
        replay_seq       INTEGER NOT NULL DEFAULT 0,
        session_id       TEXT NOT NULL,
        prompt           TEXT NOT NULL DEFAULT '',
        type             TEXT NOT NULL CHECK (type IN ('stream','callback')),
        status           TEXT NOT NULL CHECK (status IN ('queued','received','processing','completed','failed','callback_failed','cancelled')),
        params           TEXT,
        callback_url     TEXT,
        result           TEXT,
        error_message    TEXT,
        retry_count      INTEGER NOT NULL DEFAULT 0,
        callback_status  TEXT CHECK (callback_status IN ('pending','retrying','succeeded','exhausted')),
        next_callback_at TEXT,
        priority         INTEGER NOT NULL DEFAULT 0,
        scheduled_at     TEXT,
        locked_at        TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        completed_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
      CREATE INDEX IF NOT EXISTS idx_tasks_biz_id ON tasks(biz_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_biz_replay ON tasks(client_id, biz_id, replay_seq);
      CREATE INDEX IF NOT EXISTS idx_tasks_client_id ON tasks(client_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(type, status, priority, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_callback ON tasks(type, status, callback_status, next_callback_at);
      CREATE TABLE IF NOT EXISTS task_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id    TEXT NOT NULL,
        stage      TEXT NOT NULL,
        message    TEXT,
        metadata   TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id);
      CREATE TABLE IF NOT EXISTS task_results (
        task_id    TEXT PRIMARY KEY REFERENCES tasks(id),
        result     TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  /** 行 → TaskRow（DB 行键 snake_case）。 */
  private mapTask(row: Record<string, unknown> | undefined): TaskRow | undefined {
    if (row === undefined) return undefined
    return {
      id: String(row.id),
      client_id: String(row.client_id),
      biz_id: String(row.biz_id),
      replay_seq: Number(row.replay_seq),
      session_id: String(row.session_id),
      prompt: String(row.prompt ?? ''),
      type: String(row.type) as TaskType,
      status: String(row.status) as TaskStatus,
      params: row.params === null || row.params === undefined ? null : String(row.params),
      callback_url: row.callback_url === null || row.callback_url === undefined ? null : String(row.callback_url),
      result: row.result === null || row.result === undefined ? null : String(row.result),
      error_message: row.error_message === null || row.error_message === undefined ? null : String(row.error_message),
      retry_count: Number(row.retry_count ?? 0),
      callback_status: row.callback_status === null || row.callback_status === undefined
        ? null
        : String(row.callback_status) as CallbackStatus,
      next_callback_at: row.next_callback_at === null || row.next_callback_at === undefined ? null : String(row.next_callback_at),
      priority: Number(row.priority ?? 0),
      scheduled_at: row.scheduled_at === null || row.scheduled_at === undefined ? null : String(row.scheduled_at),
      locked_at: row.locked_at === null || row.locked_at === undefined ? null : String(row.locked_at),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      completed_at: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
    }
  }

  /** 唯一键冲突归一化：查 existing 行抛 DuplicateBizIdError（§6.3.1）。 */
  private raiseDuplicateOrRethrow(error: unknown, clientId: string, bizId: string, replaySeq: number): never {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('UNIQUE constraint failed')) {
      const existing = this.getTaskByBizKey(clientId, bizId, replaySeq)
      if (existing !== undefined) {
        throw new DuplicateBizIdError(
          `biz_id "${bizId}" already submitted (replay_seq=${existing.replay_seq}, status=${existing.status})`,
          {
            existing_task_id: existing.id,
            existing_replay_seq: existing.replay_seq,
            existing_status: existing.status,
          },
        )
      }
      throw new DuplicateBizIdError(`biz_id "${bizId}" conflicts with an existing submission`, {
        existing_task_id: '',
        existing_replay_seq: replaySeq,
        existing_status: '',
      })
    }
    throw error
  }

  /** 新增任务（含幂等冲突归一化）。stream 任务直接以 received 入库。 */
  createTask(input: {
    id: string
    clientId: string
    bizId: string
    replaySeq: number
    sessionId: string
    prompt: string
    type: TaskType
    params?: Record<string, unknown>
    callbackUrl?: string
    priority: number
    scheduledAt: string
    now: string
  }): TaskRow {
    try {
      this.conn.prepare(`
        INSERT INTO tasks (
          id, client_id, biz_id, replay_seq, session_id, prompt, type, status,
          params, callback_url, priority, scheduled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.clientId,
        input.bizId,
        input.replaySeq,
        input.sessionId,
        input.prompt,
        input.type,
        input.type === 'stream' ? 'received' : 'queued',
        input.params === undefined ? null : JSON.stringify(input.params),
        input.callbackUrl ?? null,
        input.priority,
        input.scheduledAt,
        input.now,
        input.now,
      )
    } catch (error: unknown) {
      this.raiseDuplicateOrRethrow(error, input.clientId, input.bizId, input.replaySeq)
    }
    const row = this.getTask(input.id)
    if (row === undefined) throw new Error('dsh-biz-bridge: task insert succeeded but read-back failed')
    return row
  }

  /** 流式任务进入处理中（received→processing，SSE 转发前置，§3.1）。 */
  markProcessing(taskId: string, now: string): boolean {
    return this.transition(taskId, 'received', 'processing', now) === 1
  }

  /** 通用乐观状态迁移：仅当当前状态匹配时生效（终态守护）。 */
  transition(taskId: string, from: TaskStatus, to: TaskStatus, now: string): number {
    return this.conn.prepare(
      'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
    ).run(to, now, taskId, from).changes
  }

  /** 设置任务完成：completed + result 写入 task_results + 可选的 completed_at；回调任务同时武装送达状态机。 */
  completeTask(
    taskId: string,
    input: { result: string; usage?: Record<string, unknown> | null; isCallback: boolean; now: string },
  ): void {
    const sql = input.isCallback
      ? `UPDATE tasks SET status='completed', completed_at=?, updated_at=?,
           callback_status='pending', next_callback_at=? WHERE id=? AND status='processing'`
      : `UPDATE tasks SET status='completed', completed_at=?, updated_at=?
         WHERE id=? AND status='processing'`
    this.conn.prepare(sql).run(
      input.now,
      input.now,
      ...(input.isCallback ? [input.now, taskId] as const : [taskId] as const),
    )
    // result 大文本写入独立表，避免主表膨胀影响热路径查询
    if (input.result !== '') {
      this.conn.prepare(
        'INSERT OR REPLACE INTO task_results (task_id, result, created_at) VALUES (?, ?, ?)',
      ).run(taskId, input.result, input.now)
    }
  }

  /** 设置任务失败（执行性错误，§9）。 */
  failTask(taskId: string, errorMessage: string, now: string): void {
    this.conn.prepare(
      `UPDATE tasks SET status='failed', error_message=?, updated_at=?, completed_at=?
       WHERE id=? AND status IN ('processing','received','queued')`,
    ).run(errorMessage, now, now, taskId)
  }

  /** 优先级调整（§6.5.6，仅 queued）；返回影响行数（0 = 状态已变）。 */
  updatePriority(taskId: string, priority: number): number {
    return this.conn.prepare(
      `UPDATE tasks SET priority=?, updated_at=? WHERE id=? AND status='queued'`,
    ).run(priority, nowIso(), taskId).changes
  }

  /** 设置任务取消（断连取消/管理取消/会话忙放弃；仅未完成状态可取消，§6.5.4）。 */
  cancelTask(taskId: string, message: string, now: string, from?: TaskStatus[]): number {
    if (from !== undefined) {
      const marks = from.map(() => '?').join(',')
      return this.conn.prepare(
        `UPDATE tasks SET status='cancelled', error_message=?, updated_at=?, completed_at=?
         WHERE id=? AND status IN (${marks})`,
      ).run(message, now, now, taskId, ...from).changes
    }
    return this.conn.prepare(
      `UPDATE tasks SET status='cancelled', error_message=?, updated_at=?, completed_at=?
       WHERE id=? AND status IN ('queued','received','processing')`,
    ).run(message, now, now, taskId).changes
  }

  /** 回调任务完成后的送达认领——pending 一次尝试（无锁单进程；配送器另有内存互斥）。 */
  getDeliveryCandidate(now: string): TaskRow | undefined {
    const rows = this.conn.prepare(`
      SELECT * FROM tasks
      WHERE type='callback' AND status='completed'
        AND callback_status IN ('pending','retrying')
        AND next_callback_at IS NOT NULL AND next_callback_at <= ?
      ORDER BY next_callback_at ASC, id ASC
      LIMIT 1
    `).all(now)
    return rows[0] === undefined ? undefined : this.mapTask(rows[0])
  }

  /** 回调执行队列认领（乐观锁：queued→processing，仅回调）。返回认领行或 undefined。 */
  claimQueuedCallback(now: string): TaskRow | undefined {
    const row = this.conn.prepare(`
      SELECT * FROM tasks
      WHERE type='callback' AND status='queued' AND scheduled_at <= ?
      ORDER BY priority ASC, scheduled_at ASC, created_at ASC, id ASC
      LIMIT 1
    `).get(now)
    const candidate = this.mapTask(row as Record<string, unknown> | undefined)
    if (candidate === undefined) return undefined
    const claimed = this.conn.prepare(
      `UPDATE tasks SET status='processing', locked_at=?, updated_at=?
       WHERE id=? AND status='queued'`,
    ).run(now, now, candidate.id).changes
    if (claimed === 0) return undefined
    const fresh = this.getTask(candidate.id)
    return fresh
  }

  /** 队列前 N 个候选（按 §7.2 排序），供调度器做会话串行筛选后定点认领。 */
  peekQueuedCallbacks(now: string, limit = 16): TaskRow[] {
    const rows = this.conn.prepare(`
      SELECT * FROM tasks
      WHERE type='callback' AND status='queued' AND scheduled_at <= ?
      ORDER BY priority ASC, scheduled_at ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(now, limit) as Array<Record<string, unknown>>
    return rows.map(row => this.mapTask(row) as TaskRow)
  }

  /** 定点认领（乐观锁），成功返回 true。 */
  claimSpecific(taskId: string, now: string): boolean {
    return this.conn.prepare(
      `UPDATE tasks SET status='processing', locked_at=?, updated_at=?
       WHERE id=? AND status='queued'`,
    ).run(now, now, taskId).changes === 1
  }

  /** 会话是否已有进行中任务（§5.8 串行化双查之一：tasks 表 processing 行）。 */
  hasActiveForSession(sessionId: string, excludeTaskId?: string): boolean {
    if (excludeTaskId === undefined) {
      const row = this.conn.prepare(
        'SELECT COUNT(*) AS c FROM tasks WHERE session_id = ? AND status = \'processing\'',
      ).get(sessionId)
      return Number((row as { c: number }).c ?? 0) > 0
    }
    const row = this.conn.prepare(
      "SELECT COUNT(*) AS c FROM tasks WHERE session_id = ? AND status = 'processing' AND id <> ?",
    ).get(sessionId, excludeTaskId)
    return Number((row as { c: number }).c ?? 0) > 0
  }

  /** 认领后因会话忙回滚（乐观条件回滚，§7.2 步骤 2）。 */
  releaseClaim(taskId: string, lockedAt: string, now: string): void {
    this.conn.prepare(
      `UPDATE tasks SET status='queued', locked_at=NULL, updated_at=?
       WHERE id=? AND status='processing' AND locked_at=?`,
    ).run(now, taskId, lockedAt)
  }

  /**
   * 回调送达结果落库（§7.4 状态机）：
   * @returns 新 callback_status（'succeeded' | 'retrying' | 'exhausted'）
   */
  recordCallbackResult(
    taskId: string,
    input: { ok: boolean; retryCount: number; maxRetry: number; retryIntervalSeconds: number; now: string },
  ): CallbackStatus {
    if (input.ok) {
      this.conn.prepare(
        `UPDATE tasks SET callback_status='succeeded', retry_count=?, updated_at=?
         WHERE id=? AND status='completed' AND callback_status IN ('pending','retrying')`,
      ).run(input.retryCount, input.now, taskId)
      return 'succeeded'
    }
    const next: CallbackStatus = input.retryCount <= input.maxRetry ? 'retrying' : 'exhausted'
    if (next === 'exhausted') {
      this.conn.prepare(
        `UPDATE tasks SET callback_status='exhausted', status='callback_failed', retry_count=?, updated_at=?
         WHERE id=? AND status='completed'`,
      ).run(input.retryCount, input.now, taskId)
    } else {
      const waitMs = input.retryIntervalSeconds * 1000
      const nextAt = new Date(Date.now() + waitMs).toISOString()
      this.conn.prepare(
        `UPDATE tasks SET callback_status='retrying', retry_count=?, next_callback_at=?, updated_at=?
         WHERE id=? AND status='completed'`,
      ).run(input.retryCount, nextAt, input.now, taskId)
    }
    return next
  }

  /** 读任务。 */
  getTask(taskId: string): TaskRow | undefined {
    return this.mapTask(this.conn.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined)
  }

  /** 读任务结果（从 task_results 表，大文本不随主查询加载）。 */
  getTaskResult(taskId: string): string | null {
    const row = this.conn.prepare('SELECT result FROM task_results WHERE task_id = ?').get(taskId) as { result?: string } | undefined
    return row?.result ?? null
  }

  /** 按幂等键读任务。 */
  getTaskByBizKey(clientId: string, bizId: string, replaySeq: number): TaskRow | undefined {
    return this.mapTask(this.conn.prepare(
      'SELECT * FROM tasks WHERE client_id = ? AND biz_id = ? AND replay_seq = ?',
    ).get(clientId, bizId, replaySeq) as Record<string, unknown> | undefined)
  }

  /** 任务分页查询（§6.5.1）。 */
  listTasks(filter: {
    status?: TaskStatus
    type?: TaskType
    clientId?: string
    bizId?: string
    startTime?: string
    endTime?: string
    page: number
    pageSize: number
  }): { total: number; tasks: TaskRow[] } {
    const where: string[] = []
    const params: Array<string | number> = []
    const push = (sql: string, value: string): void => {
      where.push(sql)
      params.push(value)
    }
    if (filter.status !== undefined) push('status = ?', filter.status)
    if (filter.type !== undefined) push('type = ?', filter.type)
    if (filter.clientId !== undefined) push('client_id = ?', filter.clientId)
    if (filter.bizId !== undefined) push('biz_id = ?', filter.bizId)
    if (filter.startTime !== undefined) push('created_at >= ?', filter.startTime)
    if (filter.endTime !== undefined) push('created_at <= ?', filter.endTime)
    const whereSql = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    const totalRow = this.conn.prepare(`SELECT COUNT(*) AS c FROM tasks${whereSql}`).get(...params)
    const total = Number((totalRow as { c: number }).c ?? 0)
    const offset = (filter.page - 1) * filter.pageSize
    const rows = this.conn.prepare(
      `SELECT * FROM tasks${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, filter.pageSize, offset) as Array<Record<string, unknown>>
    return { total, tasks: rows.map(row => this.mapTask(row) as TaskRow) }
  }

  /** 任务日志分页（§6.5.3）。 */
  listLogs(taskId: string, page: number, pageSize: number): { total: number; logs: TaskLogRow[] } {
    const totalRow = this.conn.prepare(
      'SELECT COUNT(*) AS c FROM task_logs WHERE task_id = ?',
    ).get(taskId)
    const total = Number((totalRow as { c: number }).c ?? 0)
    const offset = (page - 1) * pageSize
    const rows = this.conn.prepare(
      'SELECT * FROM task_logs WHERE task_id = ? ORDER BY id ASC LIMIT ? OFFSET ?',
    ).all(taskId, pageSize, offset) as Array<Record<string, unknown>>
    const logs: TaskLogRow[] = rows.map(row => ({
      id: Number(row.id),
      task_id: String(row.task_id),
      stage: String(row.stage),
      message: row.message === null || row.message === undefined ? null : String(row.message),
      metadata: row.metadata === null || row.metadata === undefined ? null : String(row.metadata),
      created_at: String(row.created_at),
    }))
    return { total, logs }
  }

  /** 取某阶段最后一条日志（回调体 usage 读取等场景用）。 */
  lastLogOfStage(taskId: string, stage: string): TaskLogRow | null {
    const row = this.conn.prepare(
      'SELECT * FROM task_logs WHERE task_id = ? AND stage = ? ORDER BY id DESC LIMIT 1',
    ).get(taskId, stage) as Record<string, unknown> | undefined
    if (row === undefined) return null
    return {
      id: Number(row.id),
      task_id: String(row.task_id),
      stage: String(row.stage),
      message: row.message === null || row.message === undefined ? null : String(row.message),
      metadata: row.metadata === null || row.metadata === undefined ? null : String(row.metadata),
      created_at: String(row.created_at),
    }
  }

  /** 追加任务日志（§4.2.2）。 */
  addLog(taskId: string, stage: string, message: string, metadata?: Record<string, unknown>, now?: string): void {
    this.conn.prepare(
      'INSERT INTO task_logs (task_id, stage, message, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      taskId,
      stage,
      message,
      metadata === undefined ? null : JSON.stringify(metadata),
      now ?? nowIso(),
    )
  }

  /** 全部 processing 任务快照（激活时救援用，§7.3）。 */
  listProcessingTasks(): TaskRow[] {
    const rows = this.conn.prepare(
      "SELECT * FROM tasks WHERE status = 'processing' ORDER BY created_at ASC, id ASC",
    ).all() as Array<Record<string, unknown>>
    return rows.map(row => this.mapTask(row) as TaskRow)
  }

  /** 清理超过 retentionDays 天的终态任务及其日志和结果（默认 90 天）。返回清理的任务数。 */
  cleanupExpired(retentionDays = 90): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString()
    // 1. 删除过期 task_logs（先删子表，避免外键约束问题）
    const expiredTaskIds = this.conn.prepare(
      `SELECT id FROM tasks WHERE created_at < ? AND status IN ('completed','failed','callback_failed','cancelled')`,
    ).all(cutoff) as Array<{ id: string }>
    if (expiredTaskIds.length === 0) return 0
    const ids = expiredTaskIds.map(r => r.id)
    const marks = ids.map(() => '?').join(',')
    this.conn.prepare(`DELETE FROM task_logs WHERE task_id IN (${marks})`).run(...ids)
    this.conn.prepare(`DELETE FROM task_results WHERE task_id IN (${marks})`).run(...ids)
    // 2. 删除过期 tasks
    this.conn.prepare(
      `DELETE FROM tasks WHERE created_at < ? AND status IN ('completed','failed','callback_failed','cancelled')`,
    ).run(cutoff)
    // 3. 回收空间（温和模式，不阻塞写入）
    try {
      this.conn.exec('PRAGMA incremental_vacuum')
    } catch {
      // incremental_vacuum 需要先设置 auto_vacuum=INCREMENTAL，失败时忽略
    }
    return expiredTaskIds.length
  }

  /** 统计（§6.5.7）。scope 非 admin 时限定 clientId。 */
  stats(input: { isAdmin: boolean; clientId?: string }): {
    tasks: { stream: { total: number; success: number; failed: number }; callback: { total: number; success: number; failed: number } }
    queue: { queued: number; processing: number }
    callback: { callback_failed: number; avg_retry_count: number }
  } {
    const clientWhere = input.isAdmin ? '' : ' AND client_id = ?'
    const clientParam: Array<string> = input.isAdmin ? [] : [input.clientId ?? '']
    const scoped = (sql: string, params: Array<string>): number => {
      const row = this.conn.prepare(sql).get(...params)
      return Number((row as { c: number }).c ?? 0)
    }
    const countStatus = (type: TaskType, statuses: TaskStatus[]): number => {
      const marks = statuses.map(() => '?').join(',')
      const params: Array<string> = [type, ...statuses, ...clientParam]
      return scoped(
        `SELECT COUNT(*) AS c FROM tasks WHERE type=? AND status IN (${marks})${clientWhere}`,
        params,
      )
    }
    // 口径（§6.5.7 / v0.9）：success = completed；failed = failed + callback_failed；
    // cancelled 不计入分母；total = success + failed（进行中/排队单列 queue 维度）。
    const streamSuccess = countStatus('stream', ['completed'])
    const callbackSuccess = countStatus('callback', ['completed'])
    const streamFailed = countStatus('stream', ['failed'])
    const callbackFailed = countStatus('callback', ['failed', 'callback_failed'])
    const streamTotal = streamSuccess + streamFailed
    const callbackTotal = callbackSuccess + callbackFailed
    const queued = scoped(`SELECT COUNT(*) AS c FROM tasks WHERE status='queued'${clientWhere}`, clientParam)
    const processing = scoped(`SELECT COUNT(*) AS c FROM tasks WHERE status='processing'${clientWhere}`, clientParam)
    const callbackFailedTotal = countStatus('callback', ['callback_failed'])
    const retryRow = this.conn.prepare(
      `SELECT COALESCE(AVG(retry_count), 0) AS avg FROM tasks WHERE type='callback' AND callback_status IS NOT NULL${clientWhere}`,
    ).get(...clientParam) as { avg: number }
    return {
      tasks: {
        stream: { total: streamTotal, success: streamSuccess, failed: streamFailed },
        callback: { total: callbackTotal, success: callbackSuccess, failed: callbackFailed },
      },
      queue: { queued, processing },
      callback: { callback_failed: callbackFailedTotal, avg_retry_count: Number(retryRow.avg ?? 0) },
    }
  }
}

/** 打开数据库（工厂函数；入口与工具统一走此 API）。 */
export function openBridgeDb(options: BridgeDbOptions): BridgeDb {
  return new BridgeDb(options)
}

/** 分页参数校验（page_size 默认 20、最大 100，§6.3.1）。 */
export function resolvePage(pageInput: unknown, pageSizeInput: unknown): { page: number; pageSize: number } {
  const page = pageInput === undefined || pageInput === null ? 1 : Number(pageInput)
  const pageSize = pageSizeInput === undefined || pageSizeInput === null ? 20 : Number(pageSizeInput)
  if (!Number.isSafeInteger(page) || page < 1) throw new InvalidRequestError('page must be a positive integer')
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new InvalidRequestError('page_size must be an integer between 1 and 100')
  }
  return { page, pageSize }
}

/** 时间筛选值归一化：接受 'YYYY-MM-DD'（当日 00:00:00.000Z）或完整 ISO 串。 */
export function normalizeTimeFilter(value: string, name: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new InvalidRequestError(`${name} must be a date (YYYY-MM-DD) or ISO-8601 datetime`)
  }
  return date.toISOString()
}

/** 客户端标识 / biz_id / session_id 格式校验（§6.4：^[A-Za-z0-9_-]{1,128}$）。 */
export function assertWireId(value: string, name: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new InvalidRequestError(
      `${name} must match ^[A-Za-z0-9_-]{1,128}$ (got ${JSON.stringify(value)})`,
    )
  }
}
