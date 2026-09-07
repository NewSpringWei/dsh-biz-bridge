/**
 * 运行时依赖容器（§5.5 executor / scheduler / http 共享）。
 * index.ts 负责组装；此处只定义形状，避免模块间循环依赖。
 */

import { SignatureVerifier, type Caller, type NonceSeen } from '../core/auth.ts'
import type { ResolvedConfig } from '../config/config.ts'
import { BridgeDb } from '../core/db.ts'
import { AgentPool, type SessionGateway } from '../core/session-bridge.ts'
import { RunHub } from '../core/runner.ts'
import type { TextMessageFactory } from './types.ts'
import type { FileLogger } from '../core/logger.ts'

/** 日志最小面（真实实现 ctx.logger）。 */
export interface LoggerLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** LLM 能力查询最小面（真实实现 ctx.llm）。 */
export interface LlmLike {
  listProviders(): Array<{ id: string; name: string }>
  listModels(provider: string): Promise<Array<{
    provider: string
    id: string
    name: string
    description?: string
    inputModalities?: readonly string[]
  }>>
  resolveModelInfo(provider: string, model: string): Promise<{
    provider: string
    id: string
    name: string
    description?: string
    context?: { contextWindow: number }
    defaultMaxTokens?: number
    reasoning?: {
      efforts: Array<{ id: string; name: string; description?: string }>
      defaultEffort?: string
    }
  }>
}

/**
 * 静态资源名 → 内容（/bizbridge/static/<name>，内容类型由扩展名判定）。
 * 见 http/admin-page.ts 的资源清单。
 */
export type StaticFiles = Record<string, string>

/** 全部运行时依赖。 */
export interface BridgeRuntime {
  config: ResolvedConfig
  db: BridgeDb
  pool: AgentPool
  hub: RunHub
  gateway: SessionGateway
  messageFactory: TextMessageFactory
  verifier: SignatureVerifier
  nonceSeen: NonceSeen
  logger: LoggerLike
  llm: LlmLike
  fileLogger: FileLogger
  /** 第一方参考/调试页面静态资源（index/admin/client/utils + common.js + style.css）。 */
  staticFiles: StaticFiles
}

/** 认证产物（http 层验签后传入 handler）。 */
export interface AuthenticatedCall {
  caller: Caller
}
