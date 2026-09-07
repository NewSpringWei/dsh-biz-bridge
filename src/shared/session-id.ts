/**
 * 会话 ID 命名空间隔离。
 *
 * 外部 API 使用用户提供的原始 session_id；
 * 内部 DSH 操作使用 clientId:session_id 拼接形式，
 * 防止不同 client 使用相同 session_id 导致串台。
 */

const SEPARATOR = ':'

/** 生成内部 session_id（clientId + 原始 session_id 拼接）。 */
export function internalSessionId(clientId: string, sessionId: string): string {
  return `${clientId}${SEPARATOR}${sessionId}`
}

/** 从内部 session_id 还原外部 session_id（剥离 clientId 前缀）。 */
export function externalSessionId(internalId: string): string {
  const idx = internalId.indexOf(SEPARATOR)
  return idx >= 0 ? internalId.slice(idx + 1) : internalId
}
