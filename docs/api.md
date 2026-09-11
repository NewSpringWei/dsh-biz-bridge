# dsh-biz-bridge · HTTP 接口说明文档

本文件是插件全部 HTTP 接口的**字段级参考文档**。每个接口包含：
请求方法与路径、所需 scope、请求体字段定义、响应体字段定义、错误码、调用约束。

> 调用方的签名实现参考 `public/static/common.js`（浏览器 WebCrypto）。
> 配置项与签名协议原理见 `docs/config.md`。

---

## 基础信息

- **统一前缀**：由宿主 `webServer` 承载，示例地址 `http://127.0.0.1:42731/bizbridge`
- **请求格式**：全部 POST（除 `GET /static/*`），`Content-Type: application/json`
- **认证**：每个 POST 请求需携带签名头（见下方签名协议）
- **错误响应**：统一结构 `{ "error": { "code": string, "message": string, "details": object } }`

## 签名协议

每次 POST 请求必须携带以下四个头：

| 头 | 值 |
|----|---|
| `X-Client-Id` | 白名单中的客户端 ID |
| `X-Timestamp` | unix 秒（整数字符串，如 `"1719900000"`） |
| `X-Nonce` | UUID v4（每次请求唯一；窗口期内防重放） |
| `X-Signature` | `base64( RSA-SHA256( 私钥, 签名串 ) )` |

**签名串**拼接规则（严格顺序，无分隔符）：

```
签名串 = HTTP_METHOD + REQUEST_PATH + X_TIMESTAMP + X_NONCE + SHA256_HEX(REQUEST_BODY)
```

| 段 | 说明 |
|----|------|
| `HTTP_METHOD` | 大写，固定 `"POST"` |
| `REQUEST_PATH` | 完整 pathname（含前缀），不含 query string（如 `/bizbridge/api/v1/stream`） |
| `X_TIMESTAMP` | 与请求头 `X-Timestamp` 相同的值 |
| `X_NONCE` | 与请求头 `X-Nonce` 相同的值 |
| `SHA256_HEX(REQUEST_BODY)` | 请求体原始字节的 SHA-256，输出为**十六进制小写**（如 `e3b0c44298fc...`） |

请求体为空时，SHA256 为空串的摘要值。

### 签名串样例

假设调用流式接口，请求体为 `{"prompt":"你好","session_id":"sess-1","biz_id":"REQ-001"}`：

```
请求头：
  X-Client-Id:  biz-system-a
  X-Timestamp:  1788762305
  X-Nonce:      7bb78cb0-35f7-4d23-aa9b-ed5a170099e0

请求体原始字节 → SHA-256 十六进制小写：
  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  （注意：这是空串 "" 的哈希；上面示例体有内容，实际哈希不同）

签名串（全部拼接，无分隔符）：
  POST
  /bizbridge/api/v1/stream
  1788762305
  7bb78cb0-35f7-4d23-aa9b-ed5a170099e0
  <sha256_hex_of_body>
  ──────────────────────── 拼在一起 ────────────────────────
  POST/bizbridge/api/v1/stream17887623057bb78cb0-35f7-4d23-aa9b-ed5a170099e0e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

> **关键**：`REQUEST_PATH` 必须包含插件前缀 `/bizbridge`，即 `req.url` 的完整 pathname。
> 如果漏掉前缀（写成 `/api/v1/stream`），签名验证会失败（401）。

**验证顺序**（服务端）：查公钥 → 时间戳容差（默认 300 秒）→ nonce 未重用 → 验签 → 通过后登记 nonce。

---

## 1. POST /api/v1/stream —— 流式响应

以 SSE（Server-Sent Events）方式实时推送 agent 输出。客户端断开连接即自动取消任务。

**所需 scope**：`stream`

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `biz_id` | string | 是 | 业务幂等键（1-128 位字母/数字/`_`/`-`）；同一 `client_id + biz_id` 不可重复 |
| `session_id` | string | 是 | 会话 ID（1-128 位字母/数字/`_`/`-`）；多轮对话复用同一 session_id。内部自动拼接 clientId 前缀隔离，调用方无需关心 |
| `prompt` | string | 是 | 本次用户输入文本 |
| `params` | object | 否 | agent 级覆盖参数（见下方 params 定义） |

### params 字段（可选）

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | string | LLM 提供商路由键（如 `"deepseek-official"`） |
| `model` | string | 模型 ID（如 `"deepseek-flash"`、`"deepseek-v4-flash"`） |
| `reasoningEffort` | string | 推理力度（如 `"high"`） |
| `maxTokens` | number | 最大输出 token 数（正整数） |

`params` 整体可省略，字段亦可单个省略；**省略 `provider` / `model` 时由宿主的默认模型承接**
（具体默认值取决于宿主 profile 配置，随 DSH 版本可能变化）。可用值请在提交前调用
§11「可用模型查询」获取；调用方也可传入未列出的 model ID，由 DSH adapter 自行处理。

其余 `params` 字段（如 `tools`）原样入库供能力增强插件读取，本插件不消费。

### 响应

成功时返回 `Content-Type: text/event-stream`，逐帧推送：

| 事件 | data 字段 | 说明 |
|------|----------|------|
| `start` | `{ "event": "start", "task_id": "..." }` | 任务开始 |
| `chunk` | `{ "event": "chunk", "content": "文本片段" }` | 实时文本输出 |
| `reasoning` | `{ "event": "reasoning", "content": "思考片段" }` | 思考型模型的推理过程（仅 reasoningEffort 启用时出现） |
| `done` | `{ "event": "done", "task_id": "...", "usage": {...} }` | 任务完成；`usage` 包含 token 统计 |
| `error` | `{ "event": "error", "task_id": "...", "reason": {...} }` | 任务失败 |

每 15 秒发送一条注释行（`: ping`）作为 keepalive。

失败时（入库前校验失败）返回 JSON 错误体（非 SSE）。

### 约束

- 同一 `session_id` 同时只允许一个进行中任务；冲突返回 409 `SESSION_BUSY`
- 客户端关闭 HTTP 连接 → 任务自动置 `cancelled`

---

## 2. POST /api/v1/callback —— 回调响应

提交任务后立即返回 `task_id`，agent 异步执行完成后 POST 结果到 `callback_url`。

**所需 scope**：`callback`

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `biz_id` | string | 是 | 业务幂等键（规则同 stream） |
| `session_id` | string | 是 | 会话 ID |
| `prompt` | string | 是 | 本次用户输入文本 |
| `callback_url` | string | 是 | 回调地址（必须为 `http://` 或 `https://` 绝对 URL） |
| `params` | object | 否 | agent 级覆盖参数（同 stream） |
| `priority` | number | 否 | 调度优先级（整数，越小越优先，默认 0） |

### 响应体（200）

```json
{
  "task_id": "uuid",
  "status": "queued",
  "message": "任务已入队，等待处理",
  "ext": {}
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `task_id` | string | 插件分配的任务 ID（UUID） |
| `status` | string | 固定 `"queued"` |
| `message` | string | 描述文本 |

### 约束

- 同一 `biz_id` 重复提交返回 409 `DUPLICATE_BIZ_ID`（幂等）
- 同一 `session_id` 同时只允许一个进行中任务；排队中的任务按会话串行消费

---

## 3. POST /api/v1/tasks/list —— 任务列表

**所需 scope**：业务级查自己 / `admin` 查全部

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `page` | number | 否 | 页码（从 1 开始，默认 1） |
| `page_size` | number | 否 | 每页条数（默认 20） |
| `status` | string | 否 | 状态筛选（`queued`/`received`/`processing`/`completed`/`failed`/`callback_failed`/`cancelled`） |
| `type` | string | 否 | 类型筛选（`stream`/`callback`） |
| `client_id` | string | 否 | 客户端筛选（仅 admin 可用；业务级自动锁定为自身） |
| `biz_id` | string | 否 | 业务幂等键筛选 |
| `start_time` | string | 否 | 起始日期（`YYYY-MM-DD`） |
| `end_time` | string | 否 | 截止日期（`YYYY-MM-DD`） |

### 响应体（200）

```json
{
  "total": 42,
  "page": 1,
  "page_size": 20,
  "tasks": [
    {
      "task_id": "uuid",
      "client_id": "biz-system-a",
      "biz_id": "REQ-001",
      "replay_seq": 0,
      "session_id": "sess-1",
      "type": "stream",
      "status": "completed",
      "usage": { "inputTokens": 512, "outputTokens": 512, "totalTokens": 1024, "cacheReadTokens": 0, "reasoningTokens": 0 },
      "priority": 0,
      "created_at": "2025-01-01T00:00:00.000Z",
      "updated_at": "2025-01-01T00:00:05.000Z"
    }
  ]
}
```

> 列表项不含结果全文；如需查看任务产出与 usage 明细，调用任务详情接口。

---

## 4. POST /api/v1/tasks/{id} —— 任务详情

**所需 scope**：业务级仅查自己 / `admin` 可查全部

路径参数：`id` 为任务 UUID。

### 请求体

空对象 `{}`。

### 响应体（200）

```json
{
  "task_id": "uuid",
  "client_id": "biz-system-a",
  "biz_id": "REQ-001",
  "replay_seq": 0,
  "session_id": "sess-1",
  "type": "stream",
  "status": "completed",
  "prompt": "你好",
  "params": { "model": "deepseek-chat" },
  "callback_url": null,
  "result": "agent 完整输出文本",
  "usage": { "inputTokens": 512, "outputTokens": 512, "totalTokens": 1024, "cacheReadTokens": 0, "reasoningTokens": 0 },
  "error_message": null,
  "retry_count": 0,
  "priority": 0,
  "created_at": "2025-01-01T00:00:00.000Z",
  "updated_at": "2025-01-01T00:00:05.000Z",
  "completed_at": "2025-01-01T00:00:05.000Z"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `result` | string \| null | agent 完整输出（仅 completed 有值；全文独立存于 task_results 表，经详情接口组装读取） |
| `usage` | object \| null | token 用量（completed 有值；结构同 `assistant/message` 事件 usage，取自 tasks.usage 列） |
| `error_message` | string \| null | 失败原因（仅 failed/callback_failed 有值） |
| `params` | object \| null | 提交时的 params（解析后的 JSON） |
| `callback_url` | string \| null | 回调地址（仅 callback 类型） |

> **`usage` 字段结构**（DSH `TokenUsage`）：`inputTokens`、`outputTokens` 为必有；
> `totalTokens`（整次调用总量）、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`
> 为可选——provider 未提供时该字段省略。stream 的 `done` 帧、任务详情、任务列表
> 三处 usage **同源一致**。

---

## 5. POST /api/v1/tasks/{id}/logs —— 任务日志

**所需 scope**：业务级仅查自己 / `admin` 可查全部

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `page` | number | 否 | 页码（默认 1） |
| `page_size` | number | 否 | 每页条数（默认 20） |

### 响应体（200）

```json
{
  "total": 5,
  "page": 1,
  "page_size": 20,
  "logs": [
    {
      "id": 1,
      "stage": "received",
      "message": "流式任务已接收",
      "metadata": { "biz_id": "REQ-001", "session_id": "sess-1" },
      "created_at": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

`stage` 取值：`received` → `processing` → `chunk` / `completed` / `failed` / `cancelled`。

---

## 6. POST /api/v1/tasks/{id}/cancel —— 取消任务

**所需 scope**：业务级取消自己的未开始/进行中任务 / `admin` 可取消任意非终态任务

### 请求体

空对象 `{}`。

### 响应体（200）

```json
{
  "task_id": "uuid",
  "status": "cancelled",
  "cancelled": true,
  "needAgentCancel": false
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `cancelled` | boolean | 是否成功修改状态 |
| `needAgentCancel` | boolean | 是否需要通知 agent 中止（取消 processing 任务时为 true，业务级/管理级均可） |

### 约束与错误情况

| 条件 | 错误码 |
|------|--------|
| 仅 **未开始（queued/received）/ 进行中（processing）** 任务可取消 | 已终态返回 400 `INVALID_REQUEST` |
| 非 admin 且非任务所属 client | 403 `FORBIDDEN` |

---

## 7. POST /api/v1/tasks/{id}/replay —— 重播任务

将一个已完成的 callback 任务重新入队，新任务继承原任务的业务字段。

**所需 scope**：`callback`（业务级仅操作自己）

### 请求体

空对象 `{}`。

### 响应体（200）

```json
{
  "task_id": "新任务 uuid",
  "biz_id": "REQ-001",
  "replay_seq": 1,
  "status": "queued",
  "message": "任务已重播，新任务已入队"
}
```

### 约束

- 仅 `callback` 类型任务可重播（stream 返回 400）
- 仅**已完成处理**的回调任务可重播：`status = completed / failed / callback_failed`
  （queued/received/cancelled 返回 400）
- 新任务 `replay_seq` = 该 (client_id, biz_id) 当前**最大 replay_seq + 1**（重播较旧条目也连续续号，不撞唯一键）

---

## 8. POST /api/v1/tasks/{id}/redeliver —— 再次触发回调

对已完成执行的回调任务重新武装送达状态机，使其立即向 `callback_url` 再次 POST 执行结果
（业务场景：业务侧丢失/未收到上次回调，或想重发某次执行结果；不影响任务执行记录）。

**所需 scope**：业务级仅操作自己 / `admin` 可操作全部

### 请求体

空对象 `{}`。

### 响应体（200）

```json
{
  "task_id": "uuid",
  "status": "completed",
  "callback_status": "pending",
  "message": "回调已重新武装，将在下一轮调度立即投递"
}
```

### 约束与错误情况

- 仅 `callback` 类型任务（stream 返回 400）
- 仅执行已完成的任务：`status = completed`（无论回调此前是否已送达）或
  `status = callback_failed`（送达重试耗尽；redeliver 会将其复位为 completed 重新投递）
- 任务缺少 `callback_url` 返回 400
- 非 admin 且非任务所属 client 返回 403 `FORBIDDEN`

---

## 9. POST /api/v1/tasks/{id}/priority —— 调整优先级

**所需 scope**：业务级仅操作自己 / `admin` 可操作全部

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `priority` | number | 是 | 新优先级（整数，越小越优先） |

### 响应体（200）

```json
{
  "task_id": "uuid",
  "priority": -1,
  "message": "优先级已调整"
}
```

### 约束

- 仅 `queued` 状态的任务可调优先级（否则 400）

---

## 10. POST /api/v1/stats —— 运行统计

**所需 scope**：业务级查自己 / `admin` 查全部

### 请求体

空对象 `{}`。

### 响应体（200）

```json
{
  "system": { "status": "ok", "version": "0.1.0", "uptime": 3600 },
  "tasks": {
    "stream": { "total": 100, "success": 95, "failed": 5, "success_rate": 0.95 },
    "callback": { "total": 200, "success": 190, "failed": 10, "success_rate": 0.95 }
  },
  "queue": { "queued": 3, "processing": 2 },
  "callback": { "callback_failed": 1, "avg_retry_count": 1.5 }
}
```

---

## 11. POST /api/v1/models —— 可用模型查询

从 DSH 运行时动态读取已注册的 provider 和模型列表，供调用方在提交任务前选择
`params.provider` / `params.model` / `params.reasoningEffort`。

**所需 scope**：无特殊要求（业务级或 admin 均可）

### 请求体

空对象 `{}`。

### 响应体（200）

```json
{
  "providers": [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "models": [
        {
          "id": "deepseek-chat",
          "name": "DeepSeek Chat",
          "description": "通用对话模型",
          "inputModalities": ["text"]
        },
        {
          "id": "deepseek-reasoner",
          "name": "DeepSeek Reasoner",
          "description": "推理模型",
          "inputModalities": ["text"]
        }
      ]
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `providers[].id` | string | provider 路由键（传入 `params.provider`） |
| `providers[].name` | string | 人类可读名称 |
| `providers[].models[].id` | string | 模型 ID（传入 `params.model`） |
| `providers[].models[].name` | string | 人类可读名称 |
| `providers[].models[].description` | string \| null | 可选描述 |
| `providers[].models[].inputModalities` | string[] \| null | 支持的输入模态（如 `["text"]`） |
| `providers[].models[].reasoningEfforts` | array \| null | 可用推理力度列表；每项 `{id, name, description}` |
| `providers[].models[].defaultMaxTokens` | number \| null | 模型默认最大输出 token 数 |

> 数据来自 `ctx.llm.listProviders()` + `ctx.llm.listModels()` + `ctx.llm.resolveModelInfo()`。
> 是 advisory 信息——调用方也可以传入未列出的 model ID（DSH adapter 会自行处理）。
> `reasoningEfforts` 和 `defaultMaxTokens` 来自 `resolveModelInfo`（逐模型查询），
> 查询失败时降级为 null，不影响整体返回。

---

## 12. POST /api/v1/sessions/{id}/messages —— 会话消息查询

读取 DSH 持久化的会话事件流，投影出该会话的 user / assistant 消息时间线，供管理端排查
"某次任务到底带了多少上下文"。

**所需 scope**：`admin`（业务级调用返回 403 `FORBIDDEN`）

路径参数：`id` 为**内部会话 ID**，形如 `<clientId>:<type>:<外部 session_id>`（`type` ∈
`stream` | `cb`），例如 `biz-system-a:stream:sess-1`。允许字符 `A-Za-z0-9:._-`，长度 1-128。

> ⚠️ **注意**：
> 1. 路径参数含冒号，**字面量书写与 `%3A` 百分号编码都会被接受**（服务端解码后按上面的字符集
>    重新校验）。字面量更直观，编码形式同样可用。
> 2. **任务详情 / 列表接口返回的 `session_id` 是“外部”形式（不含 `clientId:` 与 `type:` 前缀）**，
>    不能直接用作本接口的 `id`。调用方需要自行按
>    `<clientId>:<type>:<session_id>` 拼接，其中 `type` 取该任务的类型
>    （`stream` → `stream`，`callback` → `cb`）。

### 请求体

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `page` | number | 否 | 页码（从 1 开始，默认 1） |
| `page_size` | number | 否 | 每页条数（默认 20） |

### 响应体（200）

```json
{
  "session_id": "biz-system-a:stream:sess-1",
  "total": 2,
  "page": 1,
  "page_size": 20,
  "messages": [
    { "role": "user", "content": "分析一下", "seq": 1, "timestamp": null },
    { "role": "assistant", "content": "好的……", "usage": { "totalTokens": 1024 }, "seq": 2, "timestamp": null }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `messages[].role` | string | `user` \| `assistant` |
| `messages[].content` | string | 纯文本内容（仅取 `text` 块；tool 调用等其它块不投影） |
| `messages[].usage` | object \| null | 仅 assistant 消息有值，取自事件 `usage` |
| `messages[].seq` | number \| null | 会话事件序号 |
| `messages[].timestamp` | number \| null | 事件时间（毫秒）；当前恒为 `null` |

### 约束与错误情况

| 条件 | 结果 |
|------|------|
| 非 `admin` scope | 403 `FORBIDDEN` |
| **会话不存在** | **404 `NOT_FOUND`**（`session "<id>" not found`） |
| `id` 非法（超出 `A-Za-z0-9:._-` 字符集或超长） | 404 `NOT_FOUND`（route not found） |
| 宿主未注入 `sessionQuery` | 501 `NOT_IMPLEMENTED` |
| 会话存储损坏等**服务端**故障 | 500 `INTERNAL` |

> 「会话不存在」是调用方输入问题，返回 **404** 而非 500 —— 5xx 只用于真正的服务端故障，
> 以免污染告警并要求客户端做无意义的重试。

---

## 13. 回调测试接收器（调试端点）

> 这两个端点服务于第一方页面的「回调追踪」，**不是业务接口**：数据只存在内存中（30 分钟 TTL），
> 进程重启即清空。业务系统不需要、也不应依赖它们。

### 13.1 POST /api/v1/callback-test/receive —— 投递接收

调度器把回调 POST 到此处（提交任务时把 `callback_url` 指向本路径，即可在页面观察回调到达）。

**所需权限**：**仅本插件的调度器**。该端点不接受外部写入——调度器会携带一个每次插件激活
随机生成的内部令牌头 `X-Bridge-Internal-Token`，令牌只在进程内共享、从不发放给客户端。

| 条件 | 结果 |
|------|------|
| 令牌缺失 / 不匹配 | 403 `FORBIDDEN` |
| 令牌正确 | 200 `{ "ok": true, "task_id": "...", "received_at": "..." }` |

> **为什么不是"免签名"**：该端点写入的内容会被页面当作**真实回调到达**展示。若允许任意写入，
> 任何能连到端口的人都能伪造投递记录。宿主监听 `0.0.0.0` 时尤其重要。

### 13.2 POST /api/v1/callback-test/{id} —— 到达查询

**所需 scope**：`admin`，或**该任务所属 client**（即 `task.client_id === caller.clientId`）。

| 条件 | 结果 |
|------|------|
| 非 admin 且非任务所属 client | 403 `FORBIDDEN` |
| 任务不存在 | 404 `NOT_FOUND` |
| 已到达 | 200 `{ "task_id": "...", "received": true, "biz_id": "...", "status": "...", "result": ..., "received_at": "...", "raw_body": { ... } }` |
| 尚未到达 | 200 `{ "task_id": "...", "received": false }` |

路径参数 `id` 为任务 UUID（1-128 位 `A-Za-z0-9_-`）。

---

## 错误码全集

所有错误响应结构：`{ "error": { "code": string, "message": string, "details": object } }`

| 错误码 | HTTP 状态 | 说明 |
|--------|----------|------|
| `INVALID_REQUEST` | 400 | 参数校验失败（字段缺失/类型错误/终态操作） |
| `UNAUTHORIZED` | 401 | 签名验证失败（未知 client / 时间戳超窗 / nonce 重放 / 签名不匹配） |
| `FORBIDDEN` | 403 | scope 不足 / 操作他人任务 |
| `NOT_FOUND` | 404 | 任务不存在 / 路由不存在 |
| `DUPLICATE_BIZ_ID` | 409 | 幂等键冲突（同一 client_id + biz_id + replay_seq 已存在） |
| `SESSION_BUSY` | 409 | 同一 session 已有进行中任务 |
| `TASK_RUNNING` | 409 | 并发状态竞争导致本次操作未生效（可重试）：重播续号重试耗尽 / 取消被调度抢占 / redeliver 期间状态被并发修改 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超限 |
| `INTERNAL` | 500 | 服务端内部错误 |
| `NOT_IMPLEMENTED` | 501 | 宿主未提供所需服务（当前仅 `sessionQuery` 缺失时的会话消息查询） |

> `SESSION_ACTIVATING` 仍保留在错误码类型联合中，但当前实现**不再触发**——旧的
> `activating` 并发去重已随"agent 生命周期交 DSH"一并移除，调用方无需专门处理。

`DUPLICATE_BIZ_ID` 的 `details` 携带原任务信息：
```json
{
  "error": {
    "code": "DUPLICATE_BIZ_ID",
    "message": "...",
    "details": {
      "existing_task_id": "原任务 uuid",
      "existing_replay_seq": 0,
      "existing_status": "completed"
    }
  }
}
```

---

## 任务状态流转

```
callback:  queued → received → processing → completed
                                     ↓          ↓
                                  failed    callback_failed
                                     ↓
                                 cancelled

stream:    received → processing → completed
                         ↓          ↓
                      failed    cancelled
```

- `callback_failed`：回调 POST 到 `callback_url` 失败且重试耗尽
- `cancelled`：客户端断连 / 业务级取消 / 管理级取消

---

## 与 public/static/ 页面的关系

| 维度 | `public/static/` 页面 | 本文档 |
|------|----------------------|--------|
| 用途 | 浏览器交互式测试 | 代码集成参考 |
| 签名实现 | `common.js`（WebCrypto） | 调用方自行实现 |
| 面向 | 开发者手动调试 | 业务系统后端开发 |

`common.js` 提供了完整的 JS 签名与请求库，可直接在浏览器或 Node.js 中使用：
- `Bridge.makeHeaders(method, path, body)` — 构造签名头
- `Bridge.request(path, body)` — 发送签名 POST 请求
- `Bridge.sseOpen(path, body, handlers)` — 发送 SSE 请求并逐帧解析
