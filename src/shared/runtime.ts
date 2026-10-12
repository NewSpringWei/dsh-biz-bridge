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
import type { ModelSyncOutcome } from '../core/models-sync.ts'

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
  /**
   * 可配置 provider 目录（provider / displayName / settingsNs / settingsPath / declared / error）。
   * 0.2.0 起提供；缺失时不透出该字段（模型列表不受影响）。
   */
  listConfigurableProviders?(): Array<{
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    declared: boolean
    error?: string
  }>
}

/**
 * 宿主用户设置（配置面）最小面（真实实现 ctx.settings）。
 *
 * 该服务在 `dsh-base` 里挂着（`config-editor` + `settings`），所以 headless 的桥接 profile
 * **同样可写**——写的对象就是本 profile 的 `cordis.patch.yml`。dsh-web 的 Models 页走的也是它。
 */
export interface SettingsLike {
  /** 本 profile 的 settings 文档路径。 */
  readonly documentPath: string
  /** 该 profile 是否接受写入。 */
  readonly writable: boolean
  /** 读取各条目的表单值与修订号（`user` 为该条目的用户层覆盖）。 */
  describe(options?: { redactSecrets?: boolean }): Array<{
    ns: string
    revision: number
    value: unknown
    user: unknown
  }>
  /** 重置该条目的用户层字段后写入给定段落（稀疏合并到继承层之上）。 */
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
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
  /**
   * 宿主用户设置服务（配置面）。桥接 profile 是 headless，provider 路由只能由本 profile 的
   * settings 段供给；缺失时模型配置面只读、目录仍照常（见 core/models-config.ts）。
   */
  settings: SettingsLike | undefined
  /**
   * 按配置的源 profile 同步模型 provider 段（只读源、只写本 profile）。
   * 启动时调用一次；免签名触发端点也调它（见 api.md §16）。
   */
  syncModels: () => Promise<ModelSyncOutcome>
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
