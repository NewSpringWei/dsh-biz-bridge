/**
 * 桥接插件统一错误类型。HTTP 状态映射见 §6.3.1；所有非 2xx 响应使用
 * `{"error": {code, message, details}}` 结构。
 */

/** 错误码全集（§6.3.1 表 + 实现期补充的 TASK_RUNNING）。 */
export type BizErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'DUPLICATE_BIZ_ID'
  | 'SESSION_BUSY'
  | 'SESSION_ACTIVATING'
  | 'TASK_RUNNING'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL'

/** 错误码 → HTTP 状态（§6.3.1）。 */
export const ERROR_HTTP_STATUS: Record<BizErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  DUPLICATE_BIZ_ID: 409,
  SESSION_BUSY: 409,
  SESSION_ACTIVATING: 409,
  // 业务级取消已开始任务（§6.5.4 竞态语义“任务已开始，无法取消”）。
  TASK_RUNNING: 409,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL: 500,
}

/** 桥接统一错误（业务侧抛出的全部错误都收敛为此类或其子类）。 */
export class BizError extends Error {
  readonly code: BizErrorCode
  readonly details: Record<string, unknown>

  constructor(code: BizErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'BizError'
    this.code = code
    this.details = details ?? {}
  }

  /** 序列化为统一错误响应体。 */
  toBody(): { error: { code: BizErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } }
  }
}

/** 参数校验失败 → 400。 */
export class InvalidRequestError extends BizError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_REQUEST', message, details)
    this.name = 'InvalidRequestError'
  }
}

/** 验签失败（未知 client / 时间戳超窗 / nonce 重放 / 签名不匹配）→ 401。 */
export class UnauthorizedError extends BizError {
  constructor(message: string) {
    super('UNAUTHORIZED', message)
    this.name = 'UnauthorizedError'
  }
}

/** scope 越权 / 操作他人任务 → 403。 */
export class ForbiddenError extends BizError {
  constructor(message: string) {
    super('FORBIDDEN', message)
    this.name = 'ForbiddenError'
  }
}

/** 任务不存在 → 404。 */
export class NotFoundError extends BizError {
  constructor(message: string) {
    super('NOT_FOUND', message)
    this.name = 'NotFoundError'
  }
}

/** 幂等键冲突（UNIQUE(client_id, biz_id, replay_seq)）→ 409（§6.3.1 幂等闭环）。 */
export class DuplicateBizIdError extends BizError {
  constructor(
    message: string,
    details: { existing_task_id: string; existing_replay_seq: number; existing_status: string },
  ) {
    super('DUPLICATE_BIZ_ID', message, details)
    this.name = 'DuplicateBizIdError'
  }
}

/**
 * 会话忙：同一 session 已有进行中任务（§5.8 流式 409），或会话活跃但非本桥接持有
 * （§5.2.1 路径 a 不接管）。→ 409。
 */
export class SessionBusyError extends BizError {
  constructor(message: string) {
    super('SESSION_BUSY', message)
    this.name = 'SessionBusyError'
  }
}

/** 同一 session 正在激活（activating 去重，瞬态可重试）→ 409。 */
export class SessionActivatingError extends BizError {
  constructor(message: string) {
    super('SESSION_ACTIVATING', message)
    this.name = 'SessionActivatingError'
  }
}

/** 任务已开始/进行中，无法执行取消类操作（§6.5.4 竞态）→ 409。 */
export class TaskRunningError extends BizError {
  constructor(message: string) {
    super('TASK_RUNNING', message)
    this.name = 'TaskRunningError'
  }
}

/**
 * 会话 cwd 与当前工作目录不一致（§5.2.1 路径 b 校验）。调用方决定映射为
 * failed（入库后失败兜底语义，§3.1/§9），而非 4xx —— 这是执行性错误。
 */
export class CwdMismatchError extends Error {
  constructor(sessionId: string, persisted: string, current: string) {
    super(`session "${sessionId}" cwd mismatch: persisted "${persisted}" vs current "${current}"`)
    this.name = 'CwdMismatchError'
  }
}

/** 请求体超限 → 413。 */
export class PayloadTooLargeError extends BizError {
  constructor(message: string) {
    super('PAYLOAD_TOO_LARGE', message)
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * 会话占用判定异常：活跃会话的 agent 无法通过 `agents.get` 取回
 * （§5.2.2 注册表一致性守卫的兜底），转 409 SESSION_BUSY。
 */
export class UnknownSessionOwnerError extends SessionBusyError {
  constructor(sessionId: string) {
    super(`session is active but not owned by this bridge: ${sessionId}`)
    this.name = 'UnknownSessionOwnerError'
  }
}

/** 是否为 create() 幂等冲突错误（口径：message 含 already exists / already registered，§5.2.1）。 */
export function isAlreadyExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('already exists') || message.includes('already registered')
}
