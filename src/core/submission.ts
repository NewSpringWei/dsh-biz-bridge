/**
 * 提交校验组合层：ops.validateSubmit（格式/scope）+ params→AgentOptions
 * 封闭映射（§6.4），产出 executor 可直接消费的提交对象。
 */

import { extractAgentOverrides } from './agent-options.ts'
import { isInternalHost, parseAttachmentRequests, type AttachmentLimits } from './attachments.ts'
import { validateSubmit } from './ops.ts'
import { InvalidRequestError } from '../shared/errors.ts'
import type { Caller } from './auth.ts'
import type { AgentParamOverrides, AttachmentRequest, NewTaskInput, TaskType } from '../shared/types.ts'

export interface ValidatedSubmit extends NewTaskInput {
  agentOverrides?: AgentParamOverrides
  /** 入站附件声明（URI 形式，已按配置校验；提交时即拉取落盘，§6.4.4）。 */
  attachmentRequests: AttachmentRequest[]
}

/**
 * 流式/回调提交统一校验。
 * @param caller 认证后的调用者
 * @param type 任务类型（决定 scope 要求）
 * @param body 请求体
 * @param attachmentLimits 附件开关、条数与 host 白名单限制（来自配置）
 * @throws InvalidRequestError 关闭附件时仍提交附件，或附件声明不合法
 */
export function validateSubmitInput(
  caller: Caller,
  type: TaskType,
  body: Record<string, unknown>,
  attachmentLimits: Pick<
    AttachmentLimits, 'maxItems' | 'allowedHosts' | 'denyInternalHosts' | 'allowInternalCallbackHosts'
  > & { enabled: boolean },
): ValidatedSubmit {
  const base = validateSubmit(caller, type, body)
  const attachmentRequests = parseAttachmentRequests(body.attachments, attachmentLimits)
  if (!attachmentLimits.enabled && attachmentRequests.length > 0) {
    throw new InvalidRequestError('attachments are disabled by configuration (attachments.enabled=false)')
  }
  // 回调地址同样做内网校验：它是插件主动发起的出站请求，只校验协议会被用作盲 SSRF。
  // 内网联调场景可用 `attachments.allowInternalCallbackHosts` 单独放开（不影响附件约束）。
  const denyCallbackInternal = attachmentLimits.denyInternalHosts && !attachmentLimits.allowInternalCallbackHosts
  if (base.callbackUrl !== undefined && denyCallbackInternal) {
    const hostname = new URL(base.callbackUrl).hostname
    if (isInternalHost(hostname)) {
      throw new InvalidRequestError(
        `callback_url host "${hostname}" is an internal/private address and is blocked`
        + ' (set attachments.allowInternalCallbackHosts=true to permit it for local integration)',
      )
    }
  }
  return {
    ...base,
    agentOverrides: extractAgentOverrides(base.params),
    attachmentRequests,
  }
}
