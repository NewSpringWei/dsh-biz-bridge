# 便携部署包构建器（tools/bundle）

把固定版本的 **Node + DSH + pnpm + 本插件**组装成一个自带运行时的目录：目标机器解压即可跑，
**无需**预装 Node / DSH / pnpm。

## 前置条件

- Node 18+（脚本只用 Node 内置模块，下限来自全局 `fetch`）。若要顺带跑插件本体或单测，
  按 DSH 要求用 `^22.19.0 || >=24.0.0`。
- 构建时能访问网络（下载 Node 官方包、从 npm registry 装 DSH）；离线做法见「跨平台与离线」。

## 快速开始

在仓库根 `code/` 下执行：

```bash
pnpm install && pnpm build && npm run release   # 出插件 tgz（release/ 下已有同版本可跳过）
# 改 tools/bundle/bundle.config.json —— 至少确认 dshVersion / pnpmVersion / nodeVersion / platform
node tools/bundle/bundle.mjs                    # 组装（联网：下载 Node + 安装 DSH）

node tools/bundle/bundle.mjs --check dist/dsh-biz-bridge-0.1.1-win-x64   # 交付前自检
tar -a -cf dist/dsh-biz-bridge-0.1.1-win-x64.zip -C dist dsh-biz-bridge-0.1.1-win-x64
```

> 末条把 zip 写进 `dist/`（已被 gitignore）。若写在仓库根，`*.zip` 并不在忽略列表里，
> 会留下一个数百 MB 的未跟踪文件。

不联网、只看脚本会组装出什么：

```bash
node tools/bundle/bundle.mjs --skip-fetch --out .work/dry-run
```

想确保 `dist/` 里只有本次构建的东西（无旧版本、无旧 zip、`.work/` 无累积）：

```bash
node tools/bundle/bundle.mjs --clean
```

## 配置：`bundle.config.json`

| 键 | 默认 | 说明 |
|---|---|---|
| `dshVersion` | `0.1.5-rc.2` | DSH 版本 |
| `pnpmVersion` | `10.18.0` | pnpm 版本。`dsh plugin add` 是 pnpm 转发器，缺了它装不上插件 |
| `nodeVersion` | `24.14.0` | Node 版本。DSH 未声明 `engines`，无法自动推导 |
| `platform` | `""` | 目标平台（`win-x64` / `linux-x64` / `linux-arm64` / `darwin-arm64`…）；留空取宿主 |
| `nodeSource` | `""` | 本地 Node 安装目录；填了就不下载 |
| `nodeDistMirror` | `https://nodejs.org/dist` | Node 官方包镜像基址 |
| `out` | `dist` | 产物目录，相对 `code/` |
| `work` | `.work` | 中间物目录（下载缓存、npm 缓存），可整删 |

## 命令行参数

每个配置键都有同名 CLI 参数（`--dsh-version`、`--pnpm-version`、`--node-version`、`--platform`、
`--node-source`、`--node-dist-mirror`、`--out`、`--work`），**优先级高于**配置文件。另有：

| 参数 | 作用 |
|---|---|
| `--config <文件>` | 换一份配置文件 |
| `--skip-fetch` | 跳过联网步骤（不下载 Node、不装 DSH）。**产物不可交付**，只用于验证脚本 |
| `--clean` | 构建前先清空 `dist/` 与 `.work/`（去掉别的版本/平台的残留、缓存与试跑产物） |
| `--check <目录>` | 交付前自检（见下） |

## 产物

```
dsh-biz-bridge-<插件版本>-<平台>/
├─ program/                    升级单位：整体替换
│  ├─ node/                    自带 Node（含官方 LICENSE）
│  ├─ dsh/                     DSH 安装树 + pnpm
│  ├─ packages/                插件 tgz
│  └─ templates/               配置模板
├─ runtime/                    数据根（DSH_HOME 与插件 runtime.path 同指此处）
│  └─ README.txt               目录说明；首启后长出 clients/ data/ logs/ profiles/…
├─ dsh-biz-bridge.cmd / .sh    启动桥服务（一键：自行完成首次安装 / 升级重装 / 配置播种）
├─ dsh-web.cmd / .sh           启动包内 dsh web（配模型与凭据用，端口 42730）
├─ readme.md                   给运维的手册
├─ VERSION                     插件 / DSH / pnpm / Node / 平台 / 构建时间
└─ MANIFEST.sha256             全树哈希，供现场校验
```

产物只带运行期的**骨架与说明**：`clients/`（client 公钥表）、`profiles/`、`data/`、`logs/`、
`workspace/`、`settings.yaml`、`.credentials.yaml` 都在首启后生成。

两个启动器都用包内运行时，且共用同一个 `runtime/`，所以 `dsh-web` 里配的模型桥服务直接读得到。
模型与凭据请走 `dsh-web`，不要手工编辑 DSH 的配置文件。

产物体积数百 MB（含 Node 与 DSH 安装树），输出到 `dist/`，不入库。

## 交付前自检

`runtime/` 既是交付内容，又是运行数据区。一旦**在原地**把服务跑起来，它就会长出 `profiles/`
`data/` `logs/` 等——该目录**不再是干净交付物**，而且看不出区别。

```bash
node tools/bundle/bundle.mjs --check dist/dsh-biz-bridge-0.1.1-win-x64
```

通过则回显 `✓`、退出码 0；被污染则列出多余项、退出码 1。**验收请在副本上做。**

## 跨平台与离线

| 场景 | 做法 |
|---|---|
| 同平台构建 | 默认（`platform` 留空 = 宿主） |
| 交叉构建 | `--platform linux-x64` 等，脚本会下对应平台的 Node 官方包 |
| 受限网络 | `--node-dist-mirror <镜像>`；npm 侧可配 registry |
| 完全离线 | `--node-source <本地 Node 目录>`；DSH 树仍需 npm（可预热 `.work/npm-cache`） |

Linux / macOS 解压需要系统 `tar`；目标为 Linux 且用到 `.tar.xz` 时还需 `xz`。

## 许可与再分发

产物再分发了 Node 运行时与整棵 DSH 依赖树：

- 官方 Node 包自带 `LICENSE`，下载路径会带入；缺失时脚本会**告警**。
- 用 `--node-source` 复制宿主 Node 目录时，该目录可能没有 LICENSE，对外分发前请补齐。
- `node_modules` 内各包的 LICENSE 随包保留，裁剪产物时不要删。

## 常见问题

| 现象 | 处理 |
|---|---|
| `插件包不存在` | 先 `pnpm install && pnpm build && npm run release` |
| 下载或安装失败 | 换 `--node-dist-mirror` / 配 registry；完全离线用 `--node-source` |
| 校验和不匹配 | 下载中断或镜像不同步；脚本已删除坏包，重跑即可 |
| `--check` 报 `runtime/ 已被运行污染` | 该目录已被当数据目录用过；重新构建 |
