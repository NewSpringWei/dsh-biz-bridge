/**
 * 回调测试接收器的内部约定（代码复审 F1/F2 处置）。
 *
 * 该接收器是**调试设施**：内存存储、30 分钟 TTL，只服务于第一方页面的"回调追踪"。
 * 它不是业务接口，因此读写两侧都必须收紧：
 *   - 写入（receive）：只允许本插件的调度器 —— 凭每次激活随机生成的内部令牌；
 *     否则任何能连到端口的人都能注入伪造的"回调已到达"。
 *   - 读取（{id}）：需签名，且仅 `admin` 或**该任务所属 client** 可查，禁止跨 client。
 */

/** 接收端点路径（用于判断回调目标是否指向本接收器）。 */
export const CALLBACK_TEST_RECEIVE_PATH = '/bizbridge/api/v1/callback-test/receive'

/** 调度器写入接收器时携带的内部令牌头（不暴露给任何客户端）。 */
export const CALLBACK_TEST_TOKEN_HEADER = 'x-bridge-internal-token'

/**
 * 判断回调目标是否为本插件的测试接收器。
 * 只看 pathname，忽略 host/port（宿主监听的地址由 profile 配置决定）。
 */
export function isCallbackTestReceiver(url: string): boolean {
  try {
    return new URL(url).pathname === CALLBACK_TEST_RECEIVE_PATH
  } catch {
    return false
  }
}
