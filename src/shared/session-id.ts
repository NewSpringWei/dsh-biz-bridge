/**
 * 会话 ID 命名空间隔离。
 *
 * 外部 API 使用用户提供的原始 session_id；
 * 内部 DSH 操作使用 clientId:type:sessionId 拼接形式，
 * 防止不同 client 使用相同 session_id 导致串台，
 * 同时隔离 stream 和 callback 使其互不阻塞。
 */

const SEPARATOR = ':'

export type TaskTypePrefix = 'stream' | 'cb'

/** 生成内部 session_id（clientId + type + 原始 session_id 拼接）。 */
export function internalSessionId(clientId: string, sessionId: string, type: TaskTypePrefix): string {
  return `${clientId}${SEPARATOR}${type}${SEPARATOR}${sessionId}`
}

/** 从内部 session_id 还原外部 session_id（剥离 clientId 和 type 前缀）。 */
export function externalSessionId(internalId: string): string {
  // 格式：clientId:type:sessionId → 取最后一个冒号后的部分
  const lastIdx = internalId.lastIndexOf(SEPARATOR)
  return lastIdx >= 0 ? internalId.slice(lastIdx + 1) : internalId
}
