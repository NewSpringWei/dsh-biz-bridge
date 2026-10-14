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

每次请求必须携带以下四个头：

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
| `HTTP_METHOD` | 大写；业务接口为 `"POST"`，附件下载支持 `"GET"` 或 `"POST"`（见 §14） |
| `REQUEST_PATH` | 完整 pathname（含前缀），不含 query string（如 `/bizbridge/api/v1/stream`） |
| `X_TIMESTAMP` | 与请求头 `X-Timestamp` 相同的值 |
| `X_NONCE` | 与请求头 `X-Nonce` 相同的值 |
| `SHA256_HEX(REQUEST_BODY)` | 请求体原始字节的 SHA-256，输出为**十六进制小写**（如 `e3b0c44298fc...`） |

**请求体为空时**（如 GET 附件下载），SHA256 为空串的摘要值。

> **推荐**：业务系统后端集成建议使用 **POST 附件下载**（§14.3.2），签名方式与其他 POST 接口完全一致，
> 无需处理 GET 请求的特殊逻辑。GET 方式主要供前端 `<a download>` 标签配合 fetch API 使用。

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
| `attachments` | array | 否 | 入站附件声明（URI 形式，见 §14.1） |
| `params` | object | 否 | agent 级覆盖参数（见下方 params 定义） |

### params 字段（可选）

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | string | LLM 提供商路由键（如 `"deepseek-official"`） |
| `model` | string | 模型 ID（如 `"deepseek-flash"`、`"deepseek-v4-pro"`） |
| `reasoningEffort` | string | 推理力度（如 `"high"`） |
| `maxTokens` | number | 最大输出 token 数（正整数） |

`params` 整体可省略，字段亦可单个省略；**`provider` / `model` 是会话级选择**（2026-10-14 起）——
同一 `session_id` 的后续请求改这两个字段，**下一次请求即生效且会话上下文保留**（DSH 还会往会话
追加一条 "model changed" 通告，说明此前几轮由哪个模型生成）；省略这两个字段时**沿用该会话上次的
显式选择**，从未显式指定过才由宿主的默认模型承接（具体默认值取决于宿主 profile 配置，随 DSH 版本可能变化）。
可用值请在提交前调用 §11「可用模型查询」获取；调用方也可传入未列出的 model ID，由 DSH adapter 自行处理。

其余 `params` 字段（如 `tools`）原样入库供能力增强插件读取，本插件不消费。

### 响应

成功时返回 `Content-Type: text/event-stream`，逐帧推送：

| 事件 | data 字段 | 说明 |
|------|----------|------|
| `start` | `{ "event": "start", "task_id": "...", "attachments": [...] }` | 任务开始；`attachments` 为已接收的入站附件清单（无附件时为空数组） |
| `chunk` | `{ "event": "chunk", "content": "文本片段" }` | 实时文本输出 |
| `reasoning` | `{ "event": "reasoning", "content": "思考片段" }` | 思考型模型的推理过程（仅 reasoningEffort 启用时出现） |
| `done` | `{ "event": "done", "task_id": "...", "usage": {...}, "attachments": [...] }` | 任务完成；`usage` 包含 token 统计，`attachments` 为本任务产物清单（见 §14.2） |
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
| `attachments` | array | 否 | 入站附件声明（URI 形式，见 §14.1）；**入队前即完成拉取落盘**，失败则本次提交同步报错、任务不入队 |
| `callback_url` | string | 是 | 回调地址（必须为 `http://` 或 `https://` 绝对 URL；**内网/环回地址会被拒绝**，见 §14.1 SSRF 防护） |
| `params` | object | 否 | agent 级覆盖参数（同 stream） |
| `priority` | number | 否 | 调度优先级（整数，越小越优先，默认 0） |

### 响应体（200）

```json
{
  "task_id": "uuid",
  "status": "queued",
  "message": "任务已入队，等待处理",
  "ext": { "attachments": [] }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `task_id` | string | 插件分配的任务 ID（UUID） |
| `status` | string | 固定 `"queued"` |
| `message` | string | 描述文本 |
| `ext.attachments` | array | 已接收的入站附件清单（无附件时为空数组；条目结构见 §14.2） |

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
  "params": { "model": "deepseek-flash" },
  "callback_url": null,
  "result": "agent 完整输出文本",
  "usage": { "inputTokens": 512, "outputTokens": 512, "totalTokens": 1024, "cacheReadTokens": 0, "reasoningTokens": 0 },
  "error_message": null,
  "retry_count": 0,
  "priority": 0,
  "created_at": "2025-01-01T00:00:00.000Z",
  "updated_at": "2025-01-01T00:00:05.000Z",
  "completed_at": "2025-01-01T00:00:05.000Z",
  "attachments": [
    { "attachment_id": "uuid", "direction": "inbound", "name": "chart.png", "mime": "image/png", "bytes": 20480 },
    { "attachment_id": "uuid", "direction": "outbound", "name": "report.md", "mime": "text/markdown", "bytes": 1024 }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `result` | string \| null | agent 完整输出（仅 completed 有值；全文独立存于 task_results 表，经详情接口组装读取） |
| `usage` | object \| null | token 用量（completed 有值；结构同 `assistant/message` 事件 usage，取自 tasks.usage 列） |
| `error_message` | string \| null | 失败原因（仅 failed/callback_failed 有值） |
| `params` | object \| null | 提交时的 params（解析后的 JSON） |
| `callback_url` | string \| null | 回调地址（仅 callback 类型） |
| `attachments` | array | 本任务附件清单（入站在前、出站随后；条目结构见 §14.2） |

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
  "system": { "status": "ok", "version": "0.1.1", "uptime": 3600 },
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
      "id": "deepseek-official",
      "name": "DeepSeek",
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DeepSeek-V41-Flash",
          "description": null,
          "inputModalities": ["text", "image"]
        },
        {
          "id": "deepseek-v4-pro",
          "name": "DeepSeek-V4-Pro",
          "description": "Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.",
          "inputModalities": null
        }
      ]
    }
  ]
}
```

> 上例是 `llm-deepseek` 默认路由目录的**节选**；实际返回含宿主注册的全部 provider，
> 模型目录随 DSH 版本变化，请以调用结果为准。

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
| `providers[].error` | string（可选，仅失败时出现） | 查询该 provider 的模型失败的原因；此时 `models` 为空数组 |

> 数据来自 `ctx.llm.listProviders()` + `ctx.llm.listModels()` + `ctx.llm.resolveModelInfo()`。
> 是 advisory 信息——调用方也可以传入未列出的 model ID（DSH adapter 会自行处理）。
> `reasoningEfforts` 和 `defaultMaxTokens` 来自 `resolveModelInfo`（逐模型查询），
> 查询失败时降级为 null，不影响整体返回。
>
> **provider 级失败如实上报**（`error`），不再静默跳过：此前某个 provider 的 adapter 不可用时，
> 目录里只是"少一项"，与"本来就没配这个 provider"无法区分。而一个 provider 是否存在，取决于
> **本 profile** 的模型配置（见 §15）。
> 另注意：目录只证明"**注册了**"，不证明"**能用**"——账户欠费、配额用尽仍会照常列出。

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

## 14. 附件转接

业务系统与 agent 之间的附件走**双向 URI 转接**：入站由业务系统给 URI、插件拉取并落到该 client 的
工作目录后交给 agent；出站由插件发现 agent 在该工作目录里产生的文件，登记清单并开放下载。

附件字节**不落数据库**：账本（`task_attachments` 表）只记 `attachment_id`、名称、MIME、字节数与
**相对 client 工作目录的路径**；下载与再次交给模型都按该路径读取。

### 14.1 入站附件声明（`attachments` 字段）

`/api/v1/stream` 与 `/api/v1/callback` 的请求体可带 `attachments` 数组：

```json
{
  "biz_id": "REQ-001",
  "session_id": "sess-1",
  "prompt": "看看这张图里有什么问题",
  "attachments": [
    { "type": "image", "uri": "https://biz.example.com/files/chart.png", "name": "chart.png" },
    { "type": "file",  "uri": "https://biz.example.com/files/spec.pdf", "name": "规格说明.pdf" }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | `image` 或 `file` |
| `uri` | string | 是 | `http(s)` 绝对 URL（可用预签名地址）；**不接受其它协议** |
| `name` | string | 否 | 展示名；缺省由 URI 末段推断（URL 解码后取文件名） |
| `mime` | string | 否 | 声明媒体类型；图片按它校验，缺省由响应头、再按扩展名推断 |

**语义**：

- `type: "image"` 走 DSH 图片准入（会**解码校验**字节、按媒体类型入库），模型能直接看到图；
  仅支持 `image/png`、`image/jpeg`、`image/webp`、`image/gif`——其它类型报 400 `INVALID_REQUEST`。
- `type: "file"` 逐字节存储，不做类型白名单；模型侧由 DSH 投影为「只读文件句柄 + 路径」，
  agent 用文件工具按需读取。
- 附件**按声明顺序**进入本轮用户消息（图片顺序对模型可见）。
- 同一请求内重名附件自动追加 `-1`、`-2` 后缀，不覆盖。
- **拉取时机**：`stream` 在提交时、`callback` 在入队时完成下载落盘（预签名 URI 有有效期，
  不能拖到执行期）。拉取失败 → 本次提交同步报错，任务不入库、不入队。
- `replay` 会**继承**原回调任务的入站附件账本（字节仍在原落盘目录，不复制）。

**落盘位置**（相对 client 工作目录）：

```
<runtime>/workspace/<clientId>/attachments/inbound/<task_id>/<文件名>
```

**限制**（`attachments` 配置节，见 `config.md`）：单请求条数、单文件字节、单请求总字节、
拉取超时、host 白名单；默认 `≤10 个`、`≤32 MiB/文件`、`≤64 MiB/请求`、`30s`、不限制 host。
`attachments.enabled=false` 时携带该字段直接报 400。

**SSRF 防护**（`attachments.denyInternalHosts`，默认开启）：默认拒绝内网/环回/链路本地地址，
覆盖 IPv4 私有段、IPv6 ULA/链路本地/多播、**IPv4 映射与 NAT64/6to4 形式**（如
`http://[::ffff:7f00:1]/`）、以及 `localhost`/`*.local`/`*.internal`。重定向链最多
`attachments.maxRedirects`（默认 5）跳，**每跳都重新校验目标 host**。同一开关也约束
回调接口的 `callback_url`（见 §5.2）。

### 14.2 附件清单条目

以下位置返回同一结构：

| 出现位置 | 字段 |
|----------|------|
| `stream` 的 `start` 帧 | `attachments`（入站，已接收） |
| `stream` 的 `done` 帧 | `attachments`（入站 + 出站产物） |
| `callback` 提交响应 | `ext.attachments`（入站，已接收） |
| `callback` 投递体 | `attachments`（入站 + 出站产物） |
| `POST /api/v1/tasks/{id}` 详情 | `attachments`（入站 + 出站产物） |

```json
{
  "attachment_id": "3f1c…",
  "direction": "outbound",
  "name": "report.md",
  "mime": "text/markdown",
  "bytes": 1024,
  "content_hash": "a1b2c3d4…"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `attachment_id` | string | 下载用的附件 ID（UUID） |
| `direction` | string | `inbound`（业务方提交）\| `outbound`（agent 产物） |
| `name` | string | 展示名（已净化，不含路径） |
| `mime` | string \| null | 媒体类型（未知为 `null`） |
| `bytes` | number | 字节数 |
| `content_hash` | string \| null | 内容 SHA256 哈希（outbound 附件有值，inbound 为 `null`；业务系统可用于完整性校验） |

### 14.3 附件下载（GET / POST）

附件下载支持两种方式，业务系统可根据自身情况选择：

#### 14.3.1 GET /api/v1/attachments/{id}（传统方式）

**所需 scope**：可读该任务附件的一方——`admin` 或该附件所属 client（跨 client 返回 403）。

**签名**：与业务接口同一签名串规则，但 `HTTP_METHOD` 为 `GET`、请求体为空
（`SHA256_HEX("")`）；附件 ID 在**路径**里，不使用查询串。

```
GET /bizbridge/api/v1/attachments/3f1c9b2e-…
X-Client-Id / X-Timestamp / X-Nonce / X-Signature
```

**适用场景**：前端直接用 `<a download>` 标签触发下载（需要配合 fetch API 手动签名）。

#### 14.3.2 POST /api/v1/attachments/download（推荐方式）

**所需 scope**：同 GET 方式。

**签名**：与现有 POST 业务接口完全一致（`HTTP_METHOD` 为 `POST`、请求体为 JSON）。

```json
{
  "attachment_id": "3f1c9b2e-…"
}
```

```
POST /bizbridge/api/v1/attachments/download
Content-Type: application/json
X-Client-Id / X-Timestamp / X-Nonce / X-Signature

{"attachment_id":"3f1c9b2e-…"}
```

**适用场景**：业务系统后端集成，签名方式与其他 POST 接口一致，无需处理 GET 请求的特殊逻辑。

#### 14.3.3 响应（200）：原始字节流

| 响应头 | 说明 |
|--------|------|
| `Content-Type` | 该附件的媒体类型（未知为 `application/octet-stream`） |
| `Content-Length` | 字节数 |
| `Content-Disposition` | `attachment; filename="…"; filename*=UTF-8''…`（非 ASCII 名按 RFC 5987） |
| `Cache-Control` | `no-store` |

| 条件 | 结果 |
|------|------|
| 未签名 / 签名错误 / 时间戳超窗 / nonce 重放 | 401 `UNAUTHORIZED` |
| 附件不存在 | 404 `NOT_FOUND` |
| 附件属于其它 client 且调用方非 admin | 403 `FORBIDDEN` |
| 账本有条目但文件已不在磁盘 | 404 `NOT_FOUND` |
| outbound 附件内容已变更（完整性校验失败） | 404 `NOT_FOUND`（附带 "has been modified since registration"） |

> 接口只投递**账本登记过**的附件，不接受任意路径参数——不存在路径穿越或读取工作区任意文件的口子。

### 14.4 出站产物发现规则

DSH 不提供"本会话产物清单"，插件用**任务执行前后的工作目录快照差**判定产物：

1. 执行前记录 `相对路径 → (字节数, mtime)`；
2. 执行后重扫，**新增或指纹变化**的文件即本任务产物（按路径排序）；
3. 超单个文件字节上限或超单任务产物个数上限的文件**不登记**（只写运行日志）；
4. 快照跳过名为 `attachments`、`node_modules`、`.git` 的目录（`attachments` 是入站落盘区，
   不是产物），并**跳过符号链接**；遍历条目上限 5000。

**边界**：只覆盖 agent 在**自身工作目录**（`<runtime>/workspace/<clientId>/`）内的写入；
写到工作目录之外的文件不会被发现，也不会被回传。产物**不做复制**，下载接口按原路径读取。

配置见 `attachments.outbound`（默认开启，`≤20 个/任务`、`≤32 MiB/文件`）。

> **想先手工试一遍**：第一方接入测试页 `GET /bizbridge/static/client.html` 已内置附件双向操作——
> 表单里可添加入站附件（含「填入本机示例」，用插件自己的静态页当 file 附件，零外部依赖），
> 回执与产物清单会出现「下载」按钮，直接走 §14.3 的签名下载接口。
> 该页面只读取 `public/static/`，改页面后重启插件即生效（不需要重新构建 `lib/`）。

---

## 15. 模型配置面（admin）

桥接 profile 是 headless：provider 路由由**本 profile** 的 settings 段供给——`dsh-base` 里的
`llm-pi-ai` 行休眠挂载，直到该段给出 provider 才注册路由。这两个接口把"配了没有、配在哪、
生效了吗"变成一件可读可写的事；写入走宿主的 `settings` 服务，与 dsh-web 的 Models 页**同一条**
官方路径（写的是本 profile 的 `cordis.patch.yml`）。

**所需 scope**：`admin`

> **为什么不"跟着 dsh-web 走"**：DSH 的 provider 目录是 **profile 级**、凭据是 **runtime 级**
> （`$DSH_HOME/.credentials.yaml` 共享），这是上游有意的拆分。桥接是生产通道，模型集合由它
> 自己的配置**显式**给出，不隐式继承交互通道里配的实验配置。要"一份配置两处用"，就把同一段
> providers 写进两个 profile。

### 15.1 POST /api/v1/admin/models —— 读取配置面

请求体：空对象 `{}`。

响应体在 §11 的目录之外增加：

| 字段 | 类型 | 说明 |
|------|------|------|
| `namespace` | string | 承载 provider 路由的宿主条目 id（`models.settingsNamespace`，默认 `llm-pi-ai`） |
| `documentPath` | string \| null | 该条目的 settings 文档（本 profile 的 `cordis.patch.yml`）；服务缺失时 null |
| `writable` | boolean | 该 profile 是否接受写入 |
| `revision` | number \| null | 修订号；写入时作为 `expected_revision` 回传（乐观并发） |
| `configured` | object \| null | 当前生效的 providers 段；读不到时 null |
| `configurable` | array \| null | 宿主 `llm.listConfigurableProviders()` 的目录；能力缺失时 null |

### 15.2 POST /api/v1/admin/models/providers —— 写入 provider 段

| 字段 | 类型 | 说明 |
|------|------|------|
| `providers` | object（必填） | provider 路由键 → 该 provider 的 profile（字段与 `llm-pi-ai` 一致） |
| `expected_revision` | number（可选） | 取自 15.1 的 `revision`；与当前不一致则拒绝（防覆盖并发修改） |

`providers` 是**完整集合**（替换语义）：删除一个 provider 就是不再列出它。

响应体与 15.1 相同（写入后立即回读；路由注册是 live 的，**不需要重启**）。

字段级语义由 `llm-pi-ai` 自己校验（形状合法但配置不可服务时它拒绝该次写入）；
本接口只做结构校验：对象、路由名非空、值为对象。

错误：`403`（非 admin）、`400`（结构非法 / 该 profile 不可写）、`501`（宿主未挂 `settings` 服务）。

---

## 16. POST /api/v1/sync —— 模型配置同步（**免签名**）

桥接 profile 是 headless：provider 目录按 profile 存，所以在 `dsh-web`（`--profile web`）里配好的
模型，桥接进程不会自动看到。插件在**每次启动**时按配置的源 profile 读一次对方写下的补丁
（`<DSH_HOME>/profiles/<源 profile>/cordis.patch.yml`），把 `providers` 段同步进**本 profile**；
本接口是"web 侧刚改完、不想重启桥接"的即时刷新——第一方工具页
`/bizbridge/static/utils.html` 的按钮调的就是它。

**所需 scope**：无（**免签名**）。安全设计：

- **不接受任何参数**：请求体不参与任何决策；
- 源与命名空间由配置固定（`models.syncFromProfile` / `models.settingsNamespace`），调用者无法指定路径；
- 内容没变**不落盘**（指纹比对），反复调用无副作用；
- 拒绝跨源请求：带 `Origin` 且与 `Host` 不同 → 403；`Sec-Fetch-Site: cross-site` → 403。

### 响应体（200）

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `applied` \| `unchanged` \| `skipped` \| `failed` | 结果分类 |
| `reason` | string | 人类可读原因（失败时用于定位：源缺失 / 解析失败 / 含 `!!js` / 适配器拒绝） |
| `profile` / `path` | string（可选） | 源 profile 与源文件 |
| `routes` | string[]（可选） | 已生效的 provider 路由名 |
| `revision` | number \| null（可选） | 写入后该条目的 settings 修订号 |

**失败不清空**：源不可读、解析失败、`providers` 段为空、或段内出现 `!!js` 时一律**不写**，
保留上一份可用集合，并如实返回 `failed` / `skipped`。

> 只同步 `providers` 段。**默认模型（`agent-default-model`）不跟着同步**——那是通道自己的选择。

---

## 错误码全集

所有错误响应结构：`{ "error": { "code": string, "message": string, "details": object } }`

| 错误码 | HTTP 状态 | 说明 |
|--------|----------|------|
| `INVALID_REQUEST` | 400 | 参数校验失败（字段缺失/类型错误/终态操作；含附件声明不合法、超条数/字节上限、图片类型不受支持） |
| `UNAUTHORIZED` | 401 | 签名验证失败（未知 client / 时间戳超窗 / nonce 重放 / 签名不匹配） |
| `FORBIDDEN` | 403 | scope 不足 / 操作他人任务 / 下载他人附件 |
| `NOT_FOUND` | 404 | 任务不存在 / 路由不存在 / 附件不存在或文件已不在磁盘 |
| `DUPLICATE_BIZ_ID` | 409 | 幂等键冲突（同一 client_id + biz_id + replay_seq 已存在） |
| `SESSION_BUSY` | 409 | 同一 session 已有进行中任务 |
| `TASK_RUNNING` | 409 | 并发状态竞争导致本次操作未生效（可重试）：重播续号重试耗尽 / 取消被调度抢占 / redeliver 期间状态被并发修改 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超限 |
| `INTERNAL` | 500 | 服务端内部错误 |
| `NOT_IMPLEMENTED` | 501 | 宿主未提供所需服务（`sessionQuery` 缺失时的会话消息查询；`attachments` 缺失时带附件的请求） |

> `SESSION_ACTIVATING` 保留在错误码类型联合中，但当前实现不会触发，调用方无需专门处理。

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
