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

/** 结构化文本用户消息（createUserMessage 返回值的结构子集，§5.3）。 */
export interface TextUserMessage {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: 'user' }
}

export type TextMessageFactory = (text: string) => TextUserMessage

