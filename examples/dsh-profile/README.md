# examples/dsh-profile —— 独立 profile 接入说明

这是把 dsh-biz-bridge 跑成**独立业务进程**的示例目录。只有两类内容：

| 文件 | 用途 |
|------|------|
| `cordis.patch.yml` | **你要部署的配置文件**：webServer 宿主行 + 插件 config。整体覆盖到 `$DSH_HOME/profiles/bizbridge/cordis.patch.yml` 即可 |
| `README.md`（本文件） | 说明用法与配置字段 |

> 曾提供 `dsh-bizbridge.cmd` / `dsh-bizbridge` 自动启动脚本，已移除：首次安装与
> 日常启动各只需一条明确命令（见下），脚本反而带来平台与“自动装了什么”的困惑。

## 1. 快速使用

```bash
# ① 建 profile（自动带 @deepseek-ai/dsh-base）并安装插件（只做一次）
dsh plugin --profile bizbridge add <仓库>/release/dsh-biz-bridge-0.1.0.tgz

# ② 部署配置：把 cordis.patch.yml 内容覆盖到
#    $DSH_HOME/profiles/bizbridge/cordis.patch.yml
#    并完成三处替换：公钥两段、数据库绝对路径、端口（按需）

# ③ 启动（独立进程；与 web/GUI 互不影响）
dsh --profile bizbridge
```

想少敲字可自建别名：bash `alias dsh-bizbridge='dsh --profile bizbridge'`；
Windows `doskey dsh-bizbridge=dsh --profile bizbridge $*`（可选，纯个人偏好）。

## 2. cordis.patch.yml 字段说明

### webserver（HTTP 载体）
- **为什么需要**：`dsh-base` 只提供 agent/session/sessionPersistence/llm/timer 等
  核心；`webServer` 服务只有 web 外壳会插入。自定义 profile 只有 base，所以要
  在这里补一行 `@deepseek-ai/dsh-host-webserver`，插件的 `/bizbridge` 前缀挂在它上。
- `host` / `port`：**按需修改**（示例 `127.0.0.1:42731`，42731 无特殊含义）。

### auth.clients（签名白名单）
- `clientId`：业务系统/管理端各自的标识（会写进任务记录）。
- `publicKey`：RSA 公钥（SPKI PEM）。**整段粘贴**含首尾行、真实换行——用 YAML
  块标量 `|-`，不要写成一行带 `\n` 的字符串（那会导致验签失败）。
- `scope`：`stream` / `callback`（业务级，只能访问自己的数据）/ `admin`（管理级）。
  密钥对生成：启动后用工具页 `…/static/utils.html` 生成，公钥贴这里、私钥自己保管。

### database
- 建议用**绝对路径**（相对路径会落在进程 cwd 下，重启/换目录易乱）。插件会自动
  创建父目录。按平台二选一：
  ```yaml
  # Linux（服务器）:
  path: /var/lib/dsh-bizbridge/data/dsh_bridge.db
  # Windows（本地开发）:
  # path: D:/dsh-bizbridge/data/dsh_bridge.db
  ```

### 为什么这里没有 system-prompt
业务桥接的 agent 由业务请求驱动，意图由每次的 `prompt` 表达，默认**不注入**
“coding agent”式人设；需要自定义时再在配置文件里追加 `- id: system-prompt` 段
（文件里有注释好的模板）。

## 3. 验证

- 启动日志出现 `activation rescue` 与 `activated`；
- 打开 `http://127.0.0.1:42731/bizbridge/static/`（端口以你的配置为准）：
  工具页生成密钥 → 管理运维页（admin）与接入测试页（业务）各跑一次。

## 4. 常见问题

| 现象 | 处理 |
|------|------|
| 启动后访问 `/bizbridge/…` 404 | 插件行没加载：确认 bundles 含 `dsh-biz-bridge`（重新执行 ①） |
| `/bizbridge` 全 404 且日志无路由 | webserver 行未生效：确认本文件覆盖到了正确的 profile 路径并重启 |
| 请求返回 401 签名失败 | 公钥格式/内容不对：检查 PEM 是否整段粘贴、`scope` 是否包含对应接口 |
| 端口被占 | 改 webserver `port` 后重启该进程 |
| 想局域网访问 | `host: "0.0.0.0"` + 防火墙（默认 127.0.0.1 只允许本机，更安全） |

> 其余配置项（scheduler / agent.idleTimeout / 错误码 / 接口清单）见
> [`../../docs/config.md`](../../docs/config.md)。
