/**
 * 运行日志文件记录器（与 task_logs 表分离）。
 *
 * 按天轮转：文件名 dsh_biz_bridge_{yyyymmdd}.log，每天零点自动切换。
 * 写入追加模式，不锁文件（单进程场景足够）。
 * 日志格式：[ISO时间] [LEVEL] [模块] 消息 {json附加数据}
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

interface LogEntry {
  time: string
  level: LogLevel
  module: string
  message: string
  data?: Record<string, unknown>
}

function todayStamp(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function formatEntry(entry: LogEntry): string {
  const dataPart = entry.data !== undefined ? ` ${JSON.stringify(entry.data)}` : ''
  return `[${entry.time}] [${entry.level}] [${entry.module}] ${entry.message}${dataPart}\n`
}

/**
 * 文件日志记录器。
 * 调用方无需关心日期切换——每次 write 时检查当天文件是否存在，不存在则新建。
 */
export class FileLogger {
  private readonly basePath: string
  private currentDate: string

  /** @param dir 日志目录绝对路径 */
  constructor(dir: string) {
    this.basePath = dir
    this.currentDate = todayStamp()
    this.ensureDir()
  }

  private ensureDir(): void {
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true })
    }
  }

  private filePath(): string {
    return join(this.basePath, `dsh_biz_bridge_${this.currentDate}.log`)
  }

  write(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): void {
    // 检查日期轮转
    const today = todayStamp()
    if (today !== this.currentDate) {
      this.currentDate = today
      this.ensureDir()
    }

    const entry: LogEntry = {
      time: new Date().toISOString(),
      level,
      module,
      message,
      data,
    }

    try {
      appendFileSync(this.filePath(), formatEntry(entry), 'utf8')
    } catch (e) {
      // 写日志失败不应影响业务逻辑，但需要可见（避免静默丢失）
      try { console.error(`[bizbridge] fileLogger write failed: ${e instanceof Error ? e.message : String(e)}`) } catch { /* ignore */ }
    }
  }

  info(module: string, message: string, data?: Record<string, unknown>): void {
    this.write('INFO', module, message, data)
  }

  warn(module: string, message: string, data?: Record<string, unknown>): void {
    this.write('WARN', module, message, data)
  }

  error(module: string, message: string, data?: Record<string, unknown>): void {
    this.write('ERROR', module, message, data)
  }
}
