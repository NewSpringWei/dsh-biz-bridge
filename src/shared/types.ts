/**
 * dsh-biz-bridge 共享类型（纯类型，零外部依赖，可被单元测试直接引用）。
 *
 * 字段口径对齐详细设计文档 dsh-biz-bridge-design.md §4.2（tasks/task_logs）。
 */

/** 任务执行类型。 */
export type TaskType = 'stream' | 'callback'

/**
 * 任务执行状态（两轴分离中的“执行轴”，§7.4）。
 * queued（回调入队） / received（流式已接收入库） / processing / completed /
 * failed / callback_failed / cancelled。
 */
export type TaskStatus =
  | 'queued'
  | 'received'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'callback_failed'
  | 'cancelled'

/** 回调送达状态（两轴分离中的“送达轴”，§7.4；仅回调响应）。 */
export type CallbackStatus = 'pending' | 'retrying' | 'succeeded' | 'exhausted'

/** 客户端权限 scope（§6.2.5）。 */
export type AuthScope = 'stream' | 'callback' | 'admin'

/** tasks 表一行（数据库直出形态，字段名与 §4.2.1 一致）。 */
export interface TaskRow {
  id: string
  client_id: string
  biz_id: string
  replay_seq: number
  session_id: string
  prompt: string
  type: TaskType
  status: TaskStatus
  /** JSON 字符串或 null */
  params: string | null
  callback_url: string | null
  /** JSON 字符串或 null；最后一次 assistant/message 的 token 用量，完成时写入（结果全文在 task_results，不在此列） */
  usage: string | null
  error_message: string | null
  retry_count: number
  callback_status: CallbackStatus | null
  next_callback_at: string | null
  priority: number
  scheduled_at: string | null
  locked_at: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

/** task_logs 表一行（§4.2.2）。 */
export interface TaskLogRow {
  id: number
  task_id: string
  stage: string
  message: string | null
  /** JSON 字符串或 null */
  metadata: string | null
  created_at: string
}

/** params 中映射到 AgentOptions 的封闭字段（§6.4 映射规则，V1）。 */
export interface AgentParamOverrides {
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
}

/** 新建任务入参（校验后）。 */
export interface NewTaskInput {
  clientId: string
  bizId: string
  sessionId: string
  prompt: string
  type: TaskType
  /** 原始 params JSON（可含 tools 等能力增强插件字段，§5.7） */
  params?: Record<string, unknown>
  callbackUrl?: string
  /** 调度优先级（默认 0，仅回调） */
  priority?: number
  /** 计划消费时间（默认现在，仅回调） */
  scheduledAt?: string
}

/** 任务执行结局（由 runner 的 turn 归约得出，供流式/回调两侧统一消费）。 */
export type RunOutcomeKind = 'completed' | 'failed' | 'cancelled'

export interface RunOutcome {
  kind: RunOutcomeKind
  /** completed 时为按 §5.5 拼装的 text-delta 全文；其余为空串 */
  result: string
  /** 失败/取消的说明 */
  message: string
  /** 可选原因对象（turn/end reason 的 JSON 安全子集） */
  reason?: Record<string, unknown>
  /** 成功时的 token 用量（assistant/message usage） */
  usage?: Record<string, unknown> | null
}

/** 附件方向：入站 = 业务系统提交给 agent；出站 = agent 产物回传业务系统。 */
export type AttachmentDirection = 'inbound' | 'outbound'

/** 业务方提交的附件声明（URI 形式，§6.4.4）：插件负责拉取并落地。 */
export interface AttachmentRequest {
  /** 附件类别：image 走 DSH 图片准入（可进模型视野），file 走逐字节文件存储。 */
  type: 'image' | 'file'
  /** 附件来源（http/https 绝对 URL，可为预签名地址）。 */
  uri: string
  /** 展示名（可选；缺省由 URI 末段推断）。 */
  name?: string
  /** 声明媒体类型（可选；图片按它校验，缺省由响应头/扩展名推断）。 */
  mime?: string
}

/** 插件附件账本 task_attachments 一行（§4.2.4）。 */
export interface TaskAttachmentRow {
  id: string
  task_id: string
  client_id: string
  direction: AttachmentDirection
  name: string
  mime: string | null
  bytes: number
  /** 相对该 client 工作目录的 POSIX 风格相对路径（下载与再次准入的唯一依据）。 */
  rel_path: string
  /** 入站来源 URI（出站为 null）。 */
  source_uri: string | null
  /** 内容 SHA256 哈希（出站附件用于完整性校验，入站为 null）。 */
  content_hash: string | null
  created_at: string
}

/** 附件清单条目（流式 done 帧 / 回调体 / redeliver 返回给业务方的形态）。 */
export interface AttachmentEntry {
  attachment_id: string
  direction: AttachmentDirection
  name: string
  mime: string | null
  bytes: number
  /** 内容 SHA256 哈希（出站附件有值，入站为 null；业务系统可用于完整性校验）。 */
  content_hash: string | null
}

/** DSH ImageAttachmentRef 的结构镜像（零依赖类型文件不引入 DSH 包）。 */
export interface ImageAttachmentRefLike {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

/** DSH FileAttachmentRef 的结构镜像。 */
export interface FileAttachmentRefLike {
  attachmentId: string
  name: string
  bytes: number
}

/**
 * 用户消息内容块（DSH ContentBlock 中本插件会产出的三类：text / image / file，§5.3）。
 * 与 DSH 类型结构兼容；跨包传递时由 dsh/gateway.ts 做一次断言。
 */
export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRefLike }
  | { type: 'file'; attachment: FileAttachmentRefLike }

/** 结构化用户消息（createUserMessage 返回值的结构子集）。 */
export interface UserMessageLike {
  id: string
  role: 'user'
  content: UserContentBlock[]
  source: { kind: 'user' }
}

/** 由内容块构造用户消息（工厂绑定 DSH createUserMessage）。 */
export type UserMessageFactory = (content: UserContentBlock[]) => UserMessageLike

