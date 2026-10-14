/**
 * 会话级模型选择（§5.2.3）—— 与 DSH 无关的判定与日志文案，零依赖、可单测。
 *
 * 为什么单独成模块：日志的价值全在**变了才记** —— 每次请求都刷一行，
 * 真正的切换反而被埋掉；而"变没变"要连 `reasoningEffort` 一起比较（只换 effort
 * 也是换了一次路由配置）。这类判定适合当纯函数钉住，网关只负责把它交给日志。
 */

/** 桥接侧的模型选择；与 DSH `ModelSelection` 同形，effort 用 string 以免依赖品牌类型。 */
export interface SessionModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 两个选择是否指向**同一路由配置**（provider、model、effort 全等）。 */
export function sameModelSelection(
  left: SessionModelSelection | undefined,
  right: SessionModelSelection | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/**
 * 模型切换的日志文案；与上次相同时返回 `undefined`（调用方据此不刷屏）。
 * @param sessionId - 内部会话 id（`clientId:type:sessionId`），日志里用它定位是哪个会话。
 * @param previous - 该会话上一次生效的选择；`undefined` = 这是本会话第一次显式指定。
 * @param next - 本次请求要求的选择。
 */
export function modelSwitchLog(
  sessionId: string,
  previous: SessionModelSelection | undefined,
  next: SessionModelSelection,
): string | undefined {
  if (sameModelSelection(previous, next)) return undefined
  const effort = next.reasoningEffort === undefined ? '' : `（effort=${next.reasoningEffort}）`
  if (previous === undefined) {
    return `模型选择：会话 ${sessionId} 首次指定 ${next.provider}/${next.model}${effort}`
      + '（会话级，下一步请求生效）'
  }
  return `模型选择：会话 ${sessionId} 由 ${previous.provider}/${previous.model} 切到`
    + ` ${next.provider}/${next.model}${effort}（会话级，下一步请求生效；对话上下文保留）`
}

/**
 * 把一个会话的模型选择**首次装到某个 agent 上**时的日志文案。
 *
 * 单独记这一条是有用的：它区分"选择刚建立"与"选择在既有会话上生效"，
 * 排查"换了模型没反应"时第一眼看的就是它有没有出现。
 * @param sessionId - 内部会话 id。
 * @param current - 装载那一刻生效的选择；`undefined` = 尚未显式指定，沿用宿主默认。
 */
export function modelSelectionInstallLog(
  sessionId: string,
  current: SessionModelSelection | undefined,
): string {
  const shown = current === undefined
    ? '（未指定，沿用宿主默认模型）'
    : `${current.provider}/${current.model}`
  return `模型选择：会话 ${sessionId} 的会话级选择已装载到 agent → ${shown}`
}
