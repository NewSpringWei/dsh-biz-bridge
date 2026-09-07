# dsh-biz-bridge · 配置与部署

> 本文件是插件配置的**完整参考**：部署步骤、配置项字段说明、配置样例。
> 源码层 schema 见 `src/index.ts`（`Config`），缺省值的单一起源在
> `src/config/config.ts`（`DEFAULTS`）——两处同步互指。

---

## 1. 部署步骤

```bash
# ① 建 profile（自动带 @deepseek-ai/dsh-base）+ 安装插件（只做一次）
dsh plugin --profile bizbridge add <仓库>/release/dsh-biz-bridge-0.1.0.tgz

# ② 部署配置：把 cordis.patch.yml 内容覆盖到
#    $DSH_HOME/profiles/bizbridge/cordis.patch.yml
#    并完成替换：公钥两段、数据库绝对路径、端口（按需）

# ③ 启动（独立进程；与 web/GUI 互不影响）
dsh --profile bizbridge
```

启动日志出现 `activation rescue` 与 `activated` 即成功。

配置样例见同目录 [`cordis.patch.yml`](cordis.patch.yml)。

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

### database

| 键 | 缺省 | 说明 |
|----|------|------|
| `path` | `"./data/dsh_biz_bridge.db"` | SQLite 文件；相对路径按进程 cwd 解析；`:memory:` 仅测试 |
| `journalMode` | `"WAL"` | SQLite journal 模式 |
| `busyTimeout` | `5000` | busy 超时（毫秒） |

> 建议用**绝对路径**（相对路径会落在进程 cwd 下，重启/换目录易乱）。插件会自动创建父目录。

### auth

| 键 | 缺省 | 说明 |
|----|------|------|
| `timestampWindow` | `300` | 签名时间戳容差（秒） |
| `nonceCacheSize` | `10000` | nonce 防重放内存缓存容量 |
| `clients[]` | `[]` | 白名单；每项 `{ clientId, publicKey, scope }` |

`clients[]` 各字段：

| 键 | 类型 | 说明 |
|----|------|------|
| `clientId` | string | 调用方标识（业务系统/管理端各自注册） |
| `publicKey` | string | RSA 公钥（SPKI PEM）。用工具页 `utils.html` 生成密钥对，公钥粘到这里 |
| `scope` | string[] | `["stream"]` / `["callback"]` / `["admin"]`（可组合） |

scope 权限说明：
- `stream`：调用流式接口
- `callback`：调用回调接口 + 重播接口
- `admin`：管理级，可查全部任务、取消任意任务、调用统计接口
- 业务级 client 只能访问自己 `clientId` 的任务数据

> **注意**：publicKey 必须整段粘贴（含 `-----BEGIN/END PUBLIC KEY-----` 首尾行、
> 真实换行），用 YAML 块标量 `|-` 承接。不要写成一行带 `\n` 的字符串（会导致验签失败）。

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

### logging

| 键 | 缺省 | 说明 |
|----|------|------|
| `path` | `"./logs"` | 运行日志目录；建议用绝对路径；每天生成 `dsh_biz_bridge_{yyyymmdd}.log` |

> 运行日志记录插件的 HTTP 请求、任务生命周期（创建/完成/失败/取消）、调度器事件等，
> 用于排查定位问题。与 `task_logs` 表分离——task_logs 是业务级任务日志，运行日志是
> 插件级运维日志。日志中涉及任务操作时会携带 `task_id`，方便交叉定位。

---

## 3. 常见问题

| 现象 | 处理 |
|------|------|
| 启动后访问 `/bizbridge/…` 404 | 插件行没加载：确认 bundles 含 `dsh-biz-bridge`（重新执行步骤 ①） |
| `/bizbridge` 全 404 且日志无路由 | webServer 行未生效：确认配置覆盖到了正确的 profile 路径并重启 |
| 请求返回 401 签名失败 | 公钥格式/内容不对：检查 PEM 是否整段粘贴、`scope` 是否包含对应接口 |
| 端口被占 | 改 webServer `port` 后重启该进程 |
| 想局域网访问 | `host: "0.0.0.0"` + 防火墙（默认 127.0.0.1 只允许本机，更安全） |
