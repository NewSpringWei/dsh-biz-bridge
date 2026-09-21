/**
 * 运行时依赖容器（§5.5 executor / scheduler / http 共享）。
 * index.ts 负责组装；此处只定义形状，避免模块间循环依赖。
 */

import { SignatureVerifier, type Caller, type NonceSeen } from '../core/auth.ts'
import type { ResolvedConfig } from '../config/config.ts'
import { BridgeDb } from '../core/db.ts'
import { AgentPool, type SessionGateway } from '../core/session-bridge.ts'
import { RunHub } from '../core/runner.ts'
import type { AttachmentAdmissionPort, AttachmentFetcher } from '../core/attachments.ts'
import type { UserMessageFactory } from './types.ts'
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

/** 会话查询最小面（真实实现 ctx.sessionQuery）。 */
export interface SessionQueryLike {
  readSession(sessionId: string): Promise<{
    session: { id: string; createdAt: number; cwd?: string }
    events: Array<{
      type: string
      data?: unknown
      seq?: number
    }>
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
  messageFactory: UserMessageFactory
  /** DSH 附件准入端口（图片/文件持久化，§6.4.4）。 */
  attachmentAdmission: AttachmentAdmissionPort
  /** 业务方 URI 拉取端口（入站附件下载）。 */
  attachmentFetcher: AttachmentFetcher
  /** 读取 client 工作目录内的文件（执行期附件准入与下载接口共用）。 */
  readWorkspaceFile: (absolutePath: string) => Promise<Uint8Array>
  /** 某 client 的会话工作目录（<runtime>/workspace/<clientId>，业务隔离边界）。 */
  workspaceOf: (clientId: string) => string
  /** 生成附件 ID（默认 UUID；测试可注入确定性实现）。 */
  newAttachmentId: () => string
  verifier: SignatureVerifier
  nonceSeen: NonceSeen
  logger: LoggerLike
  llm: LlmLike
  sessionQuery: SessionQueryLike | undefined
  fileLogger: FileLogger
  /** 第一方参考/调试页面静态资源（index/admin/client/utils + common.js + style.css）。 */
  staticFiles: StaticFiles
  /**
   * 回调测试接收端点的内部令牌：每次插件激活随机生成，仅进程内共享。
   * 该端点拒绝外部写入——只有本插件的调度器投递回调时会带上它（见 F2 修复）。
   */
  callbackTestToken: string
}

/** 认证产物（http 层验签后传入 handler）。 */
export interface AuthenticatedCall {
  caller: Caller
}
