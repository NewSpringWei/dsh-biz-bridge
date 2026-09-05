/**
 * params → AgentOptions 封闭映射（§6.4 映射规则，V1）。
 *
 * `provider` / `model` / `reasoningEffort` / `maxTokens` 为 AgentOptions 字段
 * 全集（封闭清单），映射为 agent 级覆盖；`tools` 等其余字段不由桥接消费
 * （§5.7），原样保留在 tasks.params 供能力增强插件读取。V1 不支持采样参数
 * 覆盖（temperature 等）。
 */

import { InvalidRequestError } from '../shared/errors.ts'
import type { AgentParamOverrides } from '../shared/types.ts'

/** 校验并提取 agent 级覆盖；字段值不合法即 400（提交路径）。 */
export function extractAgentOverrides(params: Record<string, unknown> | undefined): AgentParamOverrides | undefined {
  if (params === undefined) return undefined
  const out: AgentParamOverrides = {}
  let any = false
  if (params.provider !== undefined) {
    if (typeof params.provider !== 'string' || params.provider.trim() === '') {
      throw new InvalidRequestError('params.provider must be a non-empty string')
    }
    out.provider = params.provider
    any = true
  }
  if (params.model !== undefined) {
    if (typeof params.model !== 'string' || params.model.trim() === '') {
      throw new InvalidRequestError('params.model must be a non-empty string')
    }
    out.model = params.model
    any = true
  }
  if (params.reasoningEffort !== undefined) {
    if (typeof params.reasoningEffort !== 'string' || params.reasoningEffort.trim() === '') {
      throw new InvalidRequestError('params.reasoningEffort must be a non-empty string')
    }
    out.reasoningEffort = params.reasoningEffort
    any = true
  }
  if (params.maxTokens !== undefined) {
    if (typeof params.maxTokens !== 'number' || !Number.isSafeInteger(params.maxTokens) || params.maxTokens < 1) {
      throw new InvalidRequestError('params.maxTokens must be a positive integer')
    }
    out.maxTokens = params.maxTokens
    any = true
  }
  return any ? out : undefined
}

/**
 * 执行路径读取 tasks.params（JSON 文本）时宽容解析 agent 覆盖：字段缺失/类型
 * 不符按未提供处理（submit 路径已校验过，此处仅防御手工/旧数据）。
 */
export function parseAgentOverridesLenient(paramsJson: string | null): AgentParamOverrides | undefined {
  if (paramsJson === null || paramsJson === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(paramsJson)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  try {
    return extractAgentOverrides(parsed as Record<string, unknown>)
  } catch {
    return undefined
  }
}
