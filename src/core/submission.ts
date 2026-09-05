/**
 * 提交校验组合层：ops.validateSubmit（格式/scope）+ params→AgentOptions
 * 封闭映射（§6.4），产出 executor 可直接消费的提交对象。
 */

import { extractAgentOverrides } from './agent-options.ts'
import { validateSubmit } from './ops.ts'
import type { Caller } from './auth.ts'
import type { AgentParamOverrides, NewTaskInput, TaskType } from '../shared/types.ts'

export interface ValidatedSubmit extends NewTaskInput {
  agentOverrides?: AgentParamOverrides
}

/** 流式/回调提交统一校验。 */
export function validateSubmitInput(caller: Caller, type: TaskType, body: Record<string, unknown>): ValidatedSubmit {
  const base = validateSubmit(caller, type, body)
  return { ...base, agentOverrides: extractAgentOverrides(base.params) }
}
