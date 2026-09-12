# dsh-biz-bridge · 配置与部署

> 本文件是插件配置的**完整参考**：部署步骤、配置项字段说明、配置样例。
> 源码层 schema 见 `src/index.ts`（`Config`），缺省值的单一起源在
> `src/config/config.ts`（`DEFAULTS`）。

---

## 1. 部署步骤

```bash
# ⓪ 先定数据根（重要：**必须在 ① 之前**）
#    DSH 自身数据（profile / 会话 / 凭据 / 设置）默认落 ~/.dsh；
#    服务器上通常要挪到独立目录：
#      Linux  : export DSH_HOME=/opt/dsh-bizbridge/runtime
#      Windows: set DSH_HOME=D:\dsh-bizbridge\runtime
#    ⚠️ DSH_HOME 决定 profile 的位置。若先执行 ① 再设它，profile 会留在旧 home，
#       启动时报“profile 不存在”。
#    优先级：显式配置 > $DSH_HOME > ~/.dsh（空白值视为未设）。

# ① 建 profile（自动带 @deepseek-ai/dsh-base）+ 安装插件（只做一次）
dsh plugin --profile bizbridge add ./release/dsh-biz-bridge-0.1.1.tgz
#    ⚠️ 路径写法：带 ./ 前缀并用**正斜杠**，或直接给绝对路径。
#       相对路径由 pnpm 在 profile 目录下解析，写成 program\packages\x.tgz
#       之类会被锚到 profile 内并报 ENOENT。

# ② 部署配置：把 cordis.patch.yml 内容覆盖到
#    $DSH_HOME/profiles/bizbridge/cordis.patch.yml
#    并完成替换：端口（按需）、**LLM 段（独立部署必需，见 §4）**

# ③ 启动（独立进程；与 web/GUI 互不影响）
dsh --profile bizbridge
```

启动日志出现 `activation rescue` 与 `activated` 即成功。

> **首次部署不必一次配齐：可以两段式启动。**
> client 表允许为空。此时所有 API 请求返回 401、**只有静态页可达**（fail-closed），
> 因此空跑起来是安全的：
>
> ```
> ① 启动
> ② 打开 http://127.0.0.1:42731/bizbridge/static/utils.html   # 静态页无需认证
> ③ 用工具页生成密钥对 → 公钥存成 <runtime>/clients/<clientId>.pem，
>    并在 <runtime>/clients/clients.json 里登记该 client 的 scope
> ④ 不用重启：插件每 2s 重读该目录，改完即生效
> ```
>
> `<runtime>` 即插件配置的 `runtime.path`（便携包中为 `<包根>/runtime`）。
> `clients.json` 是 `[{ clientId, scope, enabled }]`；`enabled: false` 即吊销该 client。
> 工具页是**纯本地运算**（不发任何网络请求），密钥不离开浏览器。

配置样例见同目录 [`cordis.patch.yml`](cordis.patch.yml)；
业务方接入协议（签名、接口、错误码）见 [`api.md`](api.md)。

---

## 2. 配置项全量参考

配置写在 `$DSH_HOME/profiles/bizbridge/cordis.patch.yml` 的插件行 `config:` 下；
未提供键使用缺省值。

### webServer（HTTP 载体）

独立 profile 需要单独声明 webServer 行，插件的 `/bizbridge` 前缀挂在它上面。

| 键 | 说明 |
|----|------|
| `host` | 监听地址；`127.0.0.1` 仅本机（推荐），`0.0.0.0` 局域网/外部访问 |
| `port` | 监听端口（默认示例 `42731`，按需修改） |

### runtime（磁盘根 · 唯一路径配置）

| 键 | 缺省 | 说明 |
|----|------|------|
| `path` | `"./runtime"` | 单一磁盘根；相对路径按 DSH 进程 cwd 解析；**建议用绝对路径**。其下固定派生：`data/`（SQLite）、`logs/`（运行日志）、`workspace/<clientId>/`（各业务 client 的会话工作目录） |

> 目录结构（激活/首次创建会话时自动 mkdir，无需预建）：
> ```text
> <runtime>/
> ├─ data/dsh-biz-bridge.db      # SQLite（WAL/-shm 同目录）
> ├─ logs/                        # 按天轮转 dsh_biz_bridge_{yyyymmdd}.log
> └─ workspace/<clientId>/        # 该 client 全部 agent 会话的 cwd（业务隔离 + DSH workspace-write 范围）
> ```

### database

| 键 | 缺省 | 说明 |
|----|------|------|
| `journalMode` | `"WAL"` | SQLite journal 模式 |
| `busyTimeout` | `5000` | busy 超时（毫秒） |

### auth

| 键 | 缺省 | 说明 |
|----|------|------|
| `timestampWindow` | `300` | 签名时间戳容差（秒） |
| `nonceCacheSize` | `10000` | nonce 防重放内存缓存容量 |
| `clients[]` | `[]` | **已迁移**：client 公钥表的权威位置是 `<runtime>/clients/`（见下）。本键只在那个目录尚未建立时作为**一次性迁移来源**，之后不再参与运行 |

#### client 公钥表：`<runtime>/clients/`

```
<runtime>/clients/
├─ clients.json          [{ "clientId": "...", "scope": [...], "enabled": true }]
└─ <clientId>.pem        该 client 的公钥（SPKI PEM，整段原文）
```

**改动即时生效、不需要重启**（`cordis.patch.yml` 是冷配置，改它要重启；client 是业务配置，
每接一个业务系统停一次服不合理，故移出）。

| 字段 | 说明 |
|------|------|
| `clientId` | 调用方标识；限 `[A-Za-z0-9_-]{1,64}`（它会被拼进内部 session id 与 `workspace/<clientId>/` 目录名） |
| `scope` | `["stream"]` / `["callback"]` / `["admin"]`（可组合，非空） |
| `enabled` | 省略即 `true`；置 `false` 为**停用**（废止路径，不必删文件） |

公钥怎么来：用工具页 `utils.html` 生成密钥对，把它给出的**公钥**存成
`<runtime>/clients/<clientId>.pem`（整段原文，无需转义），并在 `clients.json` 里登记一行。

> **几处刻意的行为**：
> - `clients.json` 解析失败 → **保留上一份可用集合**并记警告，一个笔误不会把所有人锁在门外；
> - 合法但为空 → 生效为空集（fail-closed：全部 API 401、只有静态页可达）；
> - 某条 `clientId` 非法/重复、`scope` 未知、缺对应 `.pem` → 只跳过该条并记问题，不影响其余。

scope 权限说明：
- `stream`：调用流式接口
- `callback`：调用回调接口 + 重播接口
- `admin`：管理级，可查全部任务、取消任意任务、调用统计接口
- 业务级 client 只能访问自己 `clientId` 的任务数据

### scheduler

| 键 | 缺省 | 说明 |
|----|------|------|
| `pollInterval` | `2` | 调度轮询间隔（秒） |
| `maxConcurrency` | `5` | 最大并发执行数（仅约束回调任务；流式由 HTTP 承载） |
| `callbackTimeout` | `30` | 回调 POST 单次超时（秒，传输层；不约束任务时长） |
| `maxRetry` | `3` | 回调失败重试次数 |
| `retryInterval` | `30` | 重试间隔（秒） |

### http

| 键 | 缺省 | 说明 |
|----|------|------|
| `sseKeepalive` | `15` | 流式响应 keepalive 注释行间隔（秒） |

### logging（运行日志）

> 运行日志记录插件的 HTTP 请求、任务生命周期（创建/完成/失败/取消）、调度器事件等，
> 用于排查定位问题。与 `task_logs` 表分离——task_logs 是业务级任务日志，运行日志是
> 插件级运维日志。日志中涉及任务操作时会携带 `task_id`，方便交叉定位。目录为
> `<runtime>/logs/`（由 `runtime.path` 派生，按天生成 `dsh_biz_bridge_{yyyymmdd}.log`）。

---

## 3. 常见问题

| 现象 | 处理 |
|------|------|
| 启动后访问 `/bizbridge/…` 404 | 插件行没加载：确认 bundles 含 `dsh-biz-bridge`（重新执行步骤 ①） |
| `/bizbridge` 全 404 且日志无路由 | webServer 行未生效：确认配置覆盖到了正确的 profile 路径并重启 |
| 请求返回 401 签名失败 | 公钥格式/内容不对：检查 PEM 是否整段粘贴、`scope` 是否包含对应接口 |
| **启动报“profile 不存在”，但插件明明装过** | `DSH_HOME` 在 `add` 之后才设置——profile 留在了旧 home。见 §1 步骤 ⓪ |
| **`add` 报 ENOENT（路径指向 profile 内）** | 插件包路径写法问题：带 `./` 前缀并用正斜杠，或用绝对路径 |
| **服务正常但任务全部失败，报 `has no provider/model`** | **未配置 LLM**（见 §4.2）。这是最常见的“看起来服务是好的”故障 |
| 端口被占 | 改 webServer `port` 后重启该进程 |
| 想局域网访问 | `host: "0.0.0.0"` + 防火墙（默认 127.0.0.1 只允许本机，更安全）；**前置 nginx 时见 §4.3** |
| 回调模式下业务方一直收不到结果 | 见 §4.4 |

---

## 4. 独立部署要点（无 `dsh web`）

本插件常以**独立 profile**部署（`dsh --profile bizbridge`），此时**没有 `dsh web` 的设置界面**。
下面几件事必须靠配置完成。

### 4.1 数据根与 `DSH_HOME`

DSH 自身数据（`profiles/`、`sessions/`、`storages/`、`settings.yaml`、`.credentials.yaml`）
统一落在 `DSH_HOME`（默认 `~/.dsh`）；插件数据落在 `runtime.path`。

**两者是两处**，若要“所有数据都在部署目录内”，必须显式设 `DSH_HOME`（见 §1 步骤 ⓪）。
两者也可指向同一目录：子目录不冲突（DSH 用 `profiles/` `sessions/` `storages/`；
插件用 `data/` `logs/` `workspace/`），备份与迁移只需一个目标。

### 4.2 LLM 配置（**不配则每个 agent 轮次都失败**）

现象识别：**服务能启动、HTTP 接口全部正常返回，但每个请求都失败**，报 `has no provider/model`。

| 配什么 | 放哪 |
|---|---|
| provider / model | `cordis.patch.yml` 覆盖 `agent-default-model` 行（样例已含，独立部署时启用） |
| **API Key** | `<DSH_HOME>/.credentials.yaml`，或启动环境变量（优先级更高） |

`llm-deepseek` 的配置项只有 `apiKeyEnv`（**环境变量名**，默认 `DEEPSEEK_API_KEY`），
**没有 `apiKey` 字段**，所以 key 只能落在上面两处。
凭据解析优先级：`启动环境变量 > <DSH_HOME>/.credentials.yaml > 项目 .env > harness-home .env`。

改动 `.credentials.yaml` **无需重启**，下一个请求即生效（便于轮换）。

> 安全提示：凭据文件仅你的 OS 用户可读，但 agent 的工具进程以同一用户运行，
> 因此该存储**无法对 agent 隔离密钥**。

其他 provider（`llm-pi-ai`）的配置与凭据在同一份 profile 配置里，按该插件的字段填写。

### 4.3 对外服务与 nginx

默认 `host: "127.0.0.1"` 只服务本机。对外两种方式：改 `0.0.0.0` + 防火墙，或**前置 nginx（推荐）**。

**前置 nginx 时必须注意 SSE** —— 插件 stream 的语义是**客户端断连即取消**，
漏配会导致“**业务方早已放弃、agent 仍在烧 token，且不报错**”：

```nginx
location /bizbridge/ {
    proxy_pass http://127.0.0.1:42731;
    proxy_http_version 1.1;
    proxy_buffering off;          # 否则流被缓冲成一坨
    proxy_read_timeout 3600s;     # 长任务可达分钟级（插件侧 keepalive 为 15s）
    proxy_set_header Connection '';
    # 关键：下游断连须传播到上游，否则取消语义失效
}
```

### 4.4 回调不通常见排查

`callback` 模式下插件会**主动 POST 到业务方的 `callback_url`**（出站方向）。

失败会记为 `callback_failed`，按 `maxRetry` / `retryInterval` 重试，详情见 `tasks/{id}/logs`。
排查顺序：先看这些状态，再查网络与防火墙。
