# 打包与本地开发（building）

> 回答“拿到源码后怎么构建/测试/改代码”。快速上手只看 [README](../README.md)；
> 本文件处理源码层的构建环境、测试与常见坑。

## 1. 环境

- Node `^22.19.0 || >=24.0.0`（**DSH 的引擎要求**；单测依赖 Node 内置的 `node:sqlite`）。
- 构建只依赖 devDependency `tsdown`：仓库根目录可直接 `pnpm install`（需能访问
  npm registry）。
- 运行期 `@deepseek-ai/*` 是插件运行时的宿主能力（由承载它的 DSH 提供），清单里
  以 **optional peer** 声明，因此独立安装/构建不会去拉它们——插件在 DSH 里加载时，
  宿主必然已具备。

## 2. 构建与发布

```bash
pnpm install        # 仓库根即可（联网拉取 tsdown）
pnpm build          # tsdown --no-dts → 产出 lib/index.mjs
npm run release     # scripts/release.mjs → 产出 release/dsh-biz-bridge-<version>.tgz
```

- 独立构建不开 dts：生成 `.d.ts` 需要解析 `@deepseek-ai/*` 的类型，而那在独立仓库
  不安装（optional peer）。运行期加载不需要类型文件；如需类型声明，在含 DSH peer
  的工程里用 `tsc`/tsdown 的 dts 能力另行产出。

- `package.json#scripts.build` 内已写死 tsdown 参数：入口 `src/index.ts`、ESM、
  `@deepseek-ai/*` 一律 external（运行时由宿主 DSH 提供），因此源码构建不要求
  peer 包先被安装。
- `release.mjs` 生成的 tgz 元数据把运行期依赖写为公开发布区间
  （schemastery 进 dependencies；cordis / dsh-* 进 peerDependencies），用于
  `dsh plugin add` 安装。
- 版本号取自 `package.json#version`，如需发 0.1.1 先改版本再 `npm run release`。

## 3. 在 DSH 工程内做源码级开发调试（推荐）

插件是随 DSH profile 运行的，改完想立刻试，最顺的路径是**让它以本地源码/构建产物
加载**：

1. 本仓库加入宿主 DSH 工程的 pnpm workspace（或把仓库放进其 `packages/`），
   让 `@deepseek-ai/*` 在构建/类型层面与宿主 DSH 保持一致；
2. `pnpm build` 后，把 profile 的插件行指向本地构建产物（开发接线形态）：
   ```yaml
   # 例如在某 profile 的 cordis.patch.yml 里，把插件的行 name 指向本仓库入口
   - id: dsh-biz-bridge
     name: '/abs/path/to/code/lib/index.mjs'
   ```
   （等价的源码形态是 `name: './src/index.ts'`，与 `cordis.patch.yml` 顶部注释一致。）
3. 启动该 profile，改代码 → 重新 build → 重启 profile（或依赖 patchReload 观察）。

## 4. 单元测试

```bash
npm test
```

- 零依赖：只使用 Node 内置模块（`node:test`、`node:crypto`、`node:sqlite`）。
- `--test-isolation=none` 让用例在当前进程跑（受限环境无法 spawn 子进程）。
- 核心逻辑改动请同步跑通 `tests/` 下全部用例（六组：auth / db / ops / session-bridge /
  runner / config）。`npm test` 会一次跑完，以其输出为准。

## 5. 生成便携部署包（自带运行时）

目标机器**不能**预装 Node / DSH 时，用 [`../tools/bundle/`](../tools/bundle/README.md)
把「固定版本 Node + DSH + pnpm + 本插件」组装成一个可带走的目录：

```bash
pnpm install && pnpm build && npm run release   # 出插件 tgz
node tools/bundle/bundle.mjs                    # 读 tools/bundle/bundle.config.json 组装
node tools/bundle/bundle.mjs --check dist/<包名>  # 交付前自检
```

- 配置项（钉死的 DSH / pnpm / Node 版本、目标平台、镜像、输出目录）见该目录 README。
- **产物不入库**：输出到 `dist/`，中间物在 `.work/`，两者均已在 `.gitignore` 内。
- `--skip-fetch` 可只验证组装逻辑不联网；`--node-source <目录>` 可离线用本地 Node。
- `--check` 会拦截"被原地跑过"的目录（`runtime/` 里长出 `profiles/` `data/` 等即不再是干净交付物）。

## 6. 常见问题

| 现象 | 处理 |
|------|------|
| `pnpm install` 联网失败 | 构建需要从 npm registry 拉取 tsdown；离线环境请直接用 `release/*.tgz`，不必本地构建 |
| 产物里出现 `@deepseek-ai/...` 的 import | 不要把这些 peer 打进产物——运行时由宿主 DSH 解析 |
| 插件行加载后没有 `/bizbridge` 路由 | 该 profile 组合缺 `webServer` 服务（base 不含）：见 [`cordis.patch.yml`](cordis.patch.yml) 的 webserver 行 |
| 启动报缺 `agents/sessions/sessionPersistence` | profile 缺 `@deepseek-ai/dsh-base`：`dsh plugin --profile <p> add` 引导初始化会自动带上 base |
