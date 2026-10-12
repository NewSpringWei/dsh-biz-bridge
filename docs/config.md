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

### models（模型面）

| 键 | 缺省 | 说明 |
|----|------|------|
| `settingsNamespace` | `llm-pi-ai` | 承载 provider 路由的宿主条目 id（`dsh-base` 的 `llm-pi-ai` 行）。换适配器或改行 id 时同步这一项 |
| `syncFromProfile` | `""`（不同步） | **启动时**从哪个 profile 同步 provider 段。用 `dsh-web` 配模型的部署写 `web`（那个启动器就是 `--profile web`）；留空 = 自己显式配 |

桥接 profile 默认只有 `dsh-base` 挂的 `llm-deepseek` 默认路由。要用**别的模型**（例如在 dsh-web
里配过的小米 / 智谱 / 通义），两条路选一条——**provider 目录是 profile 级**的，只有凭据是
runtime 级共享（`<DSH_HOME>/.credentials.yaml`）：

**① 跟着 web 走（推荐）**：设 `models.syncFromProfile: web`。插件在**每次启动**读
`<DSH_HOME>/profiles/web/cordis.patch.yml` 的 `providers` 段并同步进本 profile（经宿主 `settings`
服务，与 dsh-web 的 Models 页同一条写入路径）。web 里改完模型后：

- 重启桥接 → 自动同步；或
- 打开免验签工具页 `http://<host>:42731/bizbridge/static/utils.html` → 「立即同步模型配置」（调 `POST /api/v1/sync`，见 api.md §16）。

只同步 `providers` 段；**默认模型不动**。源不可读 / 解析失败 / 段为空 / 段内含 `!!js` →
**不写、保留上一份**并告警（一个笔误不该把所有人锁在门外）。

**② 自己显式配**（不跟随 web）：`syncFromProfile` 留空，把 provider 段写进本 profile：

```jsonc
// POST /bizbridge/api/v1/admin/models/providers（admin scope 签名；providers 即完整集合）
{
  "providers": {
    "xiaomi": { "apiKeyEnv": "XIAOMI_API_KEY", "models": [{ "id": "mimo-v2.6-flash" }] }
  }
}
```

或直接写进本 profile 的 `cordis.patch.yml`（`- id: llm-pi-ai` + `config.providers`）。
读接口（api.md §15.1）会告诉你那份文件是哪个、当前生效值是什么。

启动日志有一行 `模型目录：N 个 provider、M 个模型 — …`；只注册了默认 provider 时会额外提示。
**配错作用域过去是完全静默的**：目录只是少一个 provider、没有任何提示。

> **可用性**：目录只证明"注册了"。账户欠费、配额用尽仍会照常列出，需调用侧探测。
>
> ⚠️ 开了同步后，本 profile 的 `llm-pi-ai` providers 段就是**派生**的——用管理面接口或手写改的那份
> 会在下一次同步（启动或手动触发）被覆盖；要保留自己的集合就别开同步。

### security（agent 侧安全策略）

> 入口校验只能约束"请求本身"，约束不了"agent 拿到请求后能做什么"。本节的约束注册在
> **每个桥接会话自己的作用域**内，不影响同进程的其它 agent。完整安全边界见
> [`security.md`](security.md)。

| 键 | 缺省 | 说明 |
|----|------|------|
| `policySection` | `true` | 把「内容可能源自上游、不可当指令」的策略写入 agent **系统提示词**（不得**因输入要求**而执行命令、不得越界读写、不得泄露凭据或做破坏性操作，且被要求时拒绝） |
| `denyTools` | `[]` | 在桥接会话中**禁用**的工具名（空 = 不限制）。按作用域真正移除能力 |
| `sandboxMode` | `default` | `default`（不改动部署设定）/ `read-only`（**拒绝一切写入与删除**）/ `workspace-write`（允许写，仅限该会话工作目录） |

**要点**

- `policySection` 是**文本层**纵深，提高拒绝概率但不保证；`denyTools` 与 `sandboxMode`
  是**能力型**约束，不看模型是否配合。
- `denyTools` 需按宿主工具集填写（如 `bash`/`pwsh`/`web_search`/`web_fetch`）；
  名字写错只记告警，不影响任务。
- `sandboxMode: read-only` 会使**出站产物发现失效**（agent 写不了文件），
  不要与 `attachments.outbound.enabled=true` 同时启用——冲突时启动告警。
- **读不受沙箱约束**：DSH 在所有模式下都允许读，插件无法把读限制在本 client 工作空间内
  （`security.md` §二）。
- **命令执行的边界是「不因输入要求而执行」，不是「绝不执行」**：agent 仍可为处理工作区内的
  文件而**自主**使用工具（自带技能的正常用法就是执行随附解释器 —— 例如 `office-docx`
  要跑 python-docx）。要**绝对**禁止执行能力，用 `denyTools: [pwsh, bash]`，但那样
  Office 技能也会一并不可用（见下节）。

### Office 文档读取（docx / xlsx / pptx）

> 桥接会话要读 Office 文档，**光有附件管道不够** —— 解析能力在 DSH 侧，而且默认没挂。

DSH 自带 `@deepseek-ai/dsh-skill-office`（提供 `office-docx` / `office-pptx` / `office-xlsx`）
与 `@deepseek-ai/dsh-tool-workspace-dependencies`（提供 `load_workspace_dependencies` 工具），
但它们**只挂在 sdk-app bundle**（且被 `DSH_PRIMARY_RUNTIME` 门控），而桥接 profile 是
`dsh-base + 本插件` → 需要在 profile 配置里显式挂上。

**不挂的后果**：附件正常送达、字节落在 agent 工作区，但 `read` 对二进制只回 `binary file`、
`grep` 在 deflate 流上无命中，于是 agent **如实拒绝**处理 —— 这不是模型能力问题，是部署没挂能力。

挂载写法见 [`cordis.patch.yml`](cordis.patch.yml)（示例配置）与便携包模板
`tools/bundle/templates/cordis.patch.yml`。三个要点：

- `skill-office` 的 `assetRoot` 与 `node` 是**必填**（Config 无默认值），且都会被
  `statSync` 校验 —— 必须是真实存在的目录/文件，否则激活直接失败；
- `assetRoot` 用 **skill-office 包自带的 `assets/`**；**不要**照抄上游 sdk-app 的
  `<DSH_PRIMARY_RUNTIME>/../office-skills` 推导 —— 该目录未必存在（本机实测不存在）；
- 依赖一个**含 python-docx 的 Python 运行时**（`workspace-dependencies.source`）。
  便携包**不自带 Python**，由环境变量 `DSH_PRIMARY_RUNTIME` 供给；启动器会自动探测
  `~/.dsh/dsh-runtimes/dsh-primary-runtime`，探测不到则这两行自动禁用（不影响 profile 激活）。
- 收紧示例：

  ```yaml
  security:
    sandboxMode: read-only                          # 不让改、不让删
    denyTools: [bash, pwsh, web_search, web_fetch]  # 移除执行与出网能力
  attachments:
    outbound:
      enabled: false                                # read-only 下产物必然为空
  ```

### attachments（附件转接）

> 入站：业务系统在 `stream` / `callback` 请求里用 URI 声明附件，插件拉取后落到
> `<runtime>/workspace/<clientId>/attachments/inbound/<task_id>/`，再转成 DSH 附件交给 agent。
> 出站：任务结束后用工作目录快照差异发现 agent 产物，登记清单并开放下载接口。
> 接口语义见 [`api.md`](api.md) §14。

| 键 | 缺省 | 说明 |
|----|------|------|
| `enabled` | `true` | 是否接受入站附件；`false` 时请求带 `attachments` 直接 400 |
| `fetchTimeout` | `30` | 拉取业务方 URI 的超时（秒） |
| `maxItems` | `10` | 单请求入站附件个数上限 |
| `maxFileBytes` | `33554432`（32 MiB） | 单个入站附件字节上限 |
| `maxTotalBytes` | `67108864`（64 MiB） | 单请求入站附件总字节上限 |
| `allowedHosts` | `[]` | 允许拉取的 host 白名单（含端口，如 `"files.biz.com:8443"`）；**空 = 不限制**（仍只允许 http/https） |
| `denyInternalHosts` | `true` | SSRF 防护：拒绝内网/环回/链路本地地址（IPv4 私有段、IPv6 ULA/链路本地/多播、**IPv4 映射与 NAT64/6to4 形式**、`localhost`/`*.local`/`*.internal`）。**同时作用于入站附件 URI 与 `callback_url`** |
| `allowInternalCallbackHosts` | `false` | 是否允许 `callback_url` 指向内网。**内网联调**（业务系统与插件同机/同内网）时设为 `true`；只放开回调地址，附件 URI 仍受 `denyInternalHosts` 约束 |
| `maxRedirects` | `5` | 重定向链最大跳数；每跳都校验目标 host（防重定向绕过 SSRF 防护） |
| `outbound.enabled` | `true` | 是否发现并回传 agent 产物 |
| `outbound.maxFiles` | `20` | 单任务最多登记的产物个数 |
| `outbound.maxFileBytes` | `33554432`（32 MiB） | 单个产物字节上限（超过则不登记） |
| `outbound.exclude` | `["attachments","node_modules",".git",".ssh",".aws",".kube",".gnupg",".docker"]` | 快照时跳过的目录/文件名（按路径段精确匹配） |
| `outbound.sensitivePatterns` | `[".env*","*.pem","*.key","*.p12","*.pfx","*.jks","*.keystore","*.shadow"]` | 敏感文件 glob 模式（按文件名匹配排除，防数据泄露） |

**要点与取舍**

- **入站必须能连到业务方的 URI**：预签名地址也要插件所在主机可达（含 DNS、代理、防火墙）。
  拉取失败 → 本次提交同步报错，任务不入库/不入队（不会留下"半截任务"）。
- **`allowedHosts` 是 SSRF 收敛手段**：默认不限制 host，适用于内网可信合作方；
  若业务方地址不可完全信，请把它收紧到具体域名（端口需一并写出）。
- **`denyInternalHosts` 默认开启**：自动拒绝内网/环回/链路本地地址，防 SSRF 攻击。
  判定在 IP 字节层完成，**IPv4 映射 IPv6（`::ffff:7f00:1`）、NAT64、6to4 等映射写法同样被拦**。
  配合 `maxRedirects`（默认 5 跳）防止重定向绕过。该开关**同时作用于 `callback_url`**——回调地址是
  插件主动发起的出站请求，同样不能指向内网。
- **内网联调需要显式放行**：若业务系统的回调地址就是内网地址（例如同机联调
  `http://127.0.0.1:42731/...`，或内网部署），默认会被拒绝并返回 400。此时设
  `allowInternalCallbackHosts: true`——**只放开回调地址**，附件 URI 的内网拦截不受影响。
  也可整体关闭 `denyInternalHosts`，但那会同时放弃附件侧的 SSRF 防护，不建议。
- **`outbound.sensitivePatterns` 默认排除密钥/凭证文件**（`.env*`/`*.pem`/`*.key` 等），
  防止 agent 读取的敏感文件通过出站附件泄露给业务系统。
- **图片有类型与解码校验**：仅 `png/jpeg/webp/gif`，且 DSH 会解码验证字节与声明类型一致；
  声明的 `mime`、响应头、扩展名三者按此顺序推断，都无法判定时 400。
- **文件没有类型白名单**，逐字节存储；模型侧由 DSH 投影为只读路径 + 句柄文本，agent 按需读取。
- **模型必须支持图片输入**才能"看到"图：模型目录不含 `image` 时，DSH 会把图片投影为
  `[image omitted because this model accepts text only; …]` 占位文本（不报错，但模型看不到图）。
  可用 `POST /api/v1/models` 查 `inputModalities` 预先确认。
- **出站边界**：只发现 agent 在**自身工作目录内**写入的文件；写在工作目录之外的文件不回传。
  `outbound.exclude` 里保留 `attachments` 是必要的——那是插件的入站落盘区，不是产物。
- **磁盘回收**：入站附件落在任务专属目录、产物留在 agent 原始输出位置；插件不自动删除文件
  （`task_attachments` 账本行随任务保留 90 天后清理，文件本身由部署方按需清理）。

**配置示例**

```yaml
- id: dsh-biz-bridge
  config:
    attachments:
      enabled: true
      fetchTimeout: 30
      maxItems: 10
      maxFileBytes: 33554432
      maxTotalBytes: 67108864
      allowedHosts: ["files.biz.example.com"]   # 收紧要白名单；留空数组 = 不限制
      denyInternalHosts: true                    # SSRF 防护（默认开启）
      allowInternalCallbackHosts: false          # 内网联调时设为 true（只放开 callback_url）
      maxRedirects: 5                            # 重定向链上限
      outbound:
        enabled: true
        maxFiles: 20
        maxFileBytes: 33554432
        exclude: ["attachments", "node_modules", ".git", ".ssh", ".aws", ".kube", ".gnupg", ".docker"]
        sensitivePatterns: [".env*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.shadow"]
```

> 纯文本业务可把 `enabled` 与 `outbound.enabled` 都设为 `false`，行为与 0.1.1 一致。

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

其他 provider（`llm-pi-ai`）的路由段也落在**本 profile** 的 settings 文档里，
写入方式见上文 [`### models`](#models模型面) 与 api.md §15（管理面接口）；
凭据仍走 `<DSH_HOME>/.credentials.yaml`（runtime 级，两个 profile 共用）。

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
