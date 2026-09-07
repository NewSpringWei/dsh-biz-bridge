# dsh-biz-bridge

**DeepSeek Harness（DSH）业务桥接插件** —— 通过标准 HTTP 协议把 DSH 的 agent
能力开放给业务系统。业务方只发一个带签名的 HTTP 请求，就能拿到流式（SSE）或
回调两种响应；`session_id` 复用即多轮上下文，任务调度与日志全由插件落 SQLite。

- **当前版本**：`0.1.0`（草创/早期开发，接口可能调整，暂不建议生产关键链路）
- **源码即仓库根**：完整插件工程即本目录，代码随便看、随便改。

## 目录速览

```
.                            # 本仓库根
├─ src/                      # 插件源码（入口 src/index.ts）
├─ tests/                    # 单元测试（零依赖，npm test 即可跑）
├─ docs/                     # 用户文档（本 README 之外都在这）
│   ├─ building.md           #   源码构建、测试、开发调试
│   ├─ config.md             #   配置与部署（字段参考 + 部署步骤 + FAQ）
│   ├─ api.md                #   HTTP 接入（签名协议 + 接口定义 + 错误码）
│   └─ cordis.patch.yml      #   配置样例（直接复制到 profile 使用）
├─ release/                  # 发布产物（dsh-biz-bridge-0.1.0.tgz + CHANGELOG）
└─ public/static/            # 随插件分发的参考工具页（管理员/接入测试/密钥工具）
```

## 快速开始（clone 之后）

**准备**：Node ≥ 22；一台装有 DSH 的机器（有 `dsh` 命令即可，本插件的普通用法
不需要 web/GUI，装好 DSH 的同一环境就行）。

**第一步 · 拿到安装包**（二选一）

```bash
# A. 直接用仓库随附的发布包
ls release/dsh-biz-bridge-0.1.0.tgz

# B. 或自己从源码构建（产物同样写到 release/）
pnpm install && pnpm build && npm run release    # 前提见 docs/building.md
```

**第二步 · 建独立 profile 并安装**（只做一次；会先自动带上 `@deepseek-ai/dsh-base`
运行时核心，再装本插件）

```bash
dsh plugin --profile bizbridge add ./release/dsh-biz-bridge-0.1.0.tgz
```

**第三步 · 写一次 profile 配置**

把 [`docs/cordis.patch.yml`](docs/cordis.patch.yml)
的内容放到 `$DSH_HOME/profiles/bizbridge/cordis.patch.yml`，替换其中的公钥占位符
（用插件自带工具页生成）并按需改端口（示例 `42731`）。

**第四步 · 启动**

```bash
dsh --profile bizbridge
```

启动日志出现 `activation rescue` 与 `activated` 即成功。浏览器打开
`http://127.0.0.1:42731/bizbridge/static/`：先用「工具」页生成密钥对并填入上一步
配置，再用「接入测试」页跑一次 stream / callback。

> 常规用法就是上面这条独立进程路径：它和你的 web/GUI 互不干扰，改/重启它都不会
> 中断正在跑的 web 会话。把插件并入其它 profile 只是开发联调的可选路径，细节见
> [`docs/config.md`](docs/config.md)。

## 详细文档（子文档）

| 想看什么 | 去哪 |
|----------|------|
| 源码构建、测试、开发调试 | [`docs/building.md`](docs/building.md) |
| 配置与部署（字段参考 + 部署步骤 + FAQ） | [`docs/config.md`](docs/config.md) |
| HTTP 接入：签名协议、接口定义、错误码 | [`docs/api.md`](docs/api.md) |
| 配置样例（直接复制到 profile 使用） | [`docs/cordis.patch.yml`](docs/cordis.patch.yml) |
| 版本历史与发布说明 | [`release/CHANGELOG.md`](release/CHANGELOG.md) |

## License

MIT
