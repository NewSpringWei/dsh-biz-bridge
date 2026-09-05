# dsh-biz-bridge · 配置与接入（公开功能文档）

> 本文件是插件的**用户面功能文档**（随仓库发布）：加载方式、配置项全量参考、
> 签名协议、HTTP 接口一览、错误码、参考工具页。源码层 schema 见 `src/index.ts`
> （`Config`），缺省值的单一起源在 `src/config/config.ts`（`DEFAULTS`）——两处同步互指。

## 1. 加载插件

**常规方式（推荐）——独立进程（profile `bizbridge`）**：

```bash
# 首次：建 profile（自动带 @deepseek-ai/dsh-base）+ 安装插件
dsh plugin --profile bizbridge add <仓库>/release/dsh-biz-bridge-0.1.0.tgz
# 日常启动：独立业务进程，默认端口见示例配置（42731）
dsh --profile bizbridge
```

- 首次创建 `bizbridge` profile 时自动带上 `@deepseek-ai/dsh-base`（agent / session /
  sessionPersistence / llm / timer 等核心），插件安装后 bundle 层为
  `[base, dsh-biz-bridge]`；
- profile 用户层仍需补一个 `webServer` 宿主行与插件配置
  （端口/监听/客户端白名单），完整样例见
  [`examples/dsh-profile/`](../examples/dsh-profile/)；
- 这样业务桥接与你的 web GUI 进程互不干扰：重启/改 bizbridge 不影响 web 会话。

**备选（开发联调）——并入已有 profile**：在既有 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: dsh-biz-bridge
  config:
    auth: { clients: [] }
```

要求该组合已提供 `webServer`（web 形态自带；headless/sdk 没有）。会与宿主进程
共享会话存储、工作目录与端口，仅适合联调。

## 2. 配置项全量参考

配置写在插件行的 `config:` 下；未提供键使用缺省值。

### database
| 键 | 缺省 | 说明 |
|----|------|------|
| `path` | `"./data/dsh_bridge.db"` | SQLite 文件；相对路径按进程 cwd 解析；`:memory:` 仅测试 |
| `journalMode` | `"WAL"` | SQLite journal 模式 |
| `busyTimeout` | `5000` | busy 超时（毫秒） |

### auth
| 键 | 缺省 | 说明 |
|----|------|------|
| `timestampWindow` | `300` | 签名时间戳容差（秒） |
| `nonceCacheSize` | `10000` | nonce 防重放内存缓存容量 |
| `clients[]` | `[]` | 白名单；每项 `{ clientId, publicKey, scope }` |

`clients[]`：
- `clientId`：调用方标识（业务系统/管理端各自注册）。
- `publicKey`：RSA 公钥（SPKI PEM 文本）。浏览器用插件工具页 `utils.html`
  生成密钥对，把公钥粘到这里。
- `scope`：`["stream"]` / `["callback"]` / `["admin"]`（可组合）。业务级只能访问
  自己 `clientId` 的任务数据；`admin` 可跨 client 并调用全部管理接口。

### scheduler
| 键 | 缺省 | 说明 |
|----|------|------|
| `pollInterval` | `2` | 调度轮询间隔（秒） |
| `maxConcurrency` | `5` | 最大并发执行数（仅约束回调任务；流式由 HTTP 承载） |
| `callbackTimeout` | `30` | 回调 POST 单次超时（秒，传输层；不约束任务时长） |
| `maxRetry` | `3` | 回调失败重试次数 |
| `retryInterval` | `30` | 重试间隔（秒） |

### agent
| 键 | 缺省 | 说明 |
|----|------|------|
| `idleTimeout` | `10` | 空闲 agent 回收阈值（分钟）；`0` = 禁用回收 |

### http
| 键 | 缺省 | 说明 |
|----|------|------|
| `sseKeepalive` | `15` | 流式响应 keepalive 注释行间隔（秒） |

## 3. 签名协议（每次请求自带认证）

请求头：

| 头 | 内容 |
|----|------|
| `X-Client-Id` | 白名单中的客户端 ID |
| `X-Timestamp` | unix 秒 |
| `X-Nonce` | UUID（一次性；窗口期内防重放） |
| `X-Signature` | `base64(RSA-SHA256(私钥, 签名串))` |

签名串 = `HTTP方法 + 请求路径 + X-Timestamp + X-Nonce + SHA256(请求体)`
（路径仅 pathname 不含 query；请求体摘要为十六进制小写）。浏览器参考页与
`common.js` 里有完整实现可直接对照。验签顺序：查公钥 → 时间戳容差 →
nonce 未重用 → 验签；通过后才登记 nonce。

## 4. HTTP 接口一览

统一前缀由宿主 `webServer` 承载（`dsh --profile bizbridge` 的示例配置监听
`http://127.0.0.1:42731/bizbridge`）。除工具页外全部为 POST + 签名；非 2xx
使用统一错误体 `{ "error": { code, message, details } }`。

| 接口 | 说明 | 所需 scope |
|------|------|-----------|
| `POST /api/v1/stream` | 流式响应（SSE：start/chunk/done\|error）；断连即取消 | stream |
| `POST /api/v1/callback` | 回调响应入队（返回 task_id + queued） | callback |
| `POST /api/v1/tasks/list` | 任务列表（分页+筛选） | 业务查自己 / admin 查全部 |
| `POST /api/v1/tasks/{id}` | 任务详情 | 同上 |
| `POST /api/v1/tasks/{id}/logs` | 任务日志 | 同上 |
| `POST /api/v1/tasks/{id}/cancel` | 取消（处理中任务会中止 agent） | 同上 |
| `POST /api/v1/tasks/{id}/replay` | 重播（仅 callback） | 同上 |
| `POST /api/v1/tasks/{id}/priority` | 调优先级（仅 queued） | 同上 |
| `POST /api/v1/stats` | 运行统计 | 同上 |
| `GET  /static/…` | 工具页（index/admin/client/utils + 共享资源） | 免签名 |

主要错误码：`INVALID_REQUEST`400、`UNAUTHORIZED`401、`FORBIDDEN`403、
`NOT_FOUND`404、`DUPLICATE_BIZ_ID`409（幂等，`details` 携带原任务）、
`SESSION_BUSY`409（同 session 已有进行中任务）、`TASK_RUNNING`409、
`PAYLOAD_TOO_LARGE`413、`INTERNAL`500。

要点：
- `biz_id` = 请求级幂等键（每次提交唯一）；同一 `client_id + biz_id + replay_seq`
  重复提交返回 409；`replay_seq` 每次重播 +1（回调体里用作防重放对账）。
- 同一 `session_id` 同一时刻只允许一个进行中任务（串行）；流式撞上返回 409，
  回调任务在队列里按会话串行消费。
- 任务不设时长上限；失控任务用管理级取消兜底。
- `params` 中 `provider/model/reasoningEffort/maxTokens` 会映射为 agent 级覆盖；
  其余字段（如 `tools`）原样入库供能力增强插件读取。

## 5. 参考工具页

插件自带四个纯静态页面（浏览器验签、私钥仅内存、F5 即丢）：

| 路径 | 用途 |
|------|------|
| `…/static/`（index.html） | 入口导航 |
| `…/static/admin.html` | 管理运维（管理级验签）：统计/任务/取消/重播/优先级 |
| `…/static/client.html` | 接入测试（业务级验签）：stream SSE、callback、幂等 409 演示、自有任务 |
| `…/static/utils.html` | 工具（免验签）：RSA 密钥对生成、时间戳转换 |
