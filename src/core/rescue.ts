/**
 * 激活时救援（§7.3）——独立成模块便于单元测试。
 *
 * 插件激活（含进程重启、插件 stop 后重载）时旧持有者已随上一代 fiber 销毁：
 * - 回调 processing → queued（重新入队；执行时经 §5.2.1 路径 b resume 恢复，
 *   被中断的 turn 由 resume() 修复补写收尾事件）；
 * - 流式 processing → cancelled（SSE 唯一消费者进程已消失；置终态而非僵尸
 *   排队——§7.3 单进程前提下的字面实现细化，见 README 偏差记录）；
 * 逐条写 task_logs（stage=received/cancelled, metadata.reason='rescued'）。
 */

import { nowIso, type BridgeDb } from './db.ts'

export interface RescueResult {
  requeued: number
  cancelled: number
}

/** 执行救援。now 注入便于测试固定时间。 */
export function rescueProcessing(db: BridgeDb, log: (message: string) => void, now: string = nowIso()): RescueResult {
  const rows = db.listProcessingTasks()
  if (rows.length === 0) return { requeued: 0, cancelled: 0 }
  let requeued = 0
  let cancelled = 0
  for (const row of rows) {
    if (row.type === 'callback') {
      const changed = db.transition(row.id, 'processing', 'queued', now)
      if (changed === 1) {
        db.addLog(row.id, 'received', '持有者丢失，重新入队（激活时救援）', { reason: 'rescued' }, now)
        requeued++
      }
    } else {
      const changed = db.cancelTask(row.id, '持有者进程重启，流式连接已断开', now, ['processing'])
      if (changed === 1) {
        db.addLog(row.id, 'cancelled', '持有者进程重启，流式连接已断开', { reason: 'rescued' }, now)
        cancelled++
      }
    }
  }
  log(`activation rescue: requeued ${requeued} callback task(s), cancelled ${cancelled} orphaned stream task(s)`)
  return { requeued, cancelled }
}
