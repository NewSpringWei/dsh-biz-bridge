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

/** 日志最小面（真实实现 ctx.logger）。 */
export interface LoggerLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
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
  /** 第一方参考/调试页面静态资源（index/admin/client/utils + common.js + style.css）。 */
  staticFiles: StaticFiles
}

/** 认证产物（http 层验签后传入 handler）。 */
export interface AuthenticatedCall {
  caller: Caller
}
