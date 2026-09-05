# 打包与本地开发（building）

> 回答“拿到源码后怎么构建/测试/改代码”。快速上手只看 [README](../README.md)；
> 本文件处理源码层的构建环境、测试与常见坑。

## 1. 环境

- Node ≥ 22（`node:sqlite` 内置）。
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
- 用例矩阵与“如何增改测试”是私有资料，不在公开仓库；公开侧只保证：核心逻辑改动
  请同步跑通 `tests/` 下 54 个用例（auth / db / ops / session-bridge / runner / config）。

## 5. 常见问题

| 现象 | 处理 |
|------|------|
| `pnpm install` 联网失败 | 构建需要从 npm registry 拉取 tsdown；离线环境请直接用 `release/*.tgz`，不必本地构建 |
| `pnpm build` 后检查产物缺 `@deepseek-ai/...` import 报错 | 属预期：运行时由宿主 DSH 解析，勿把 peer 打进产物 |
| 插件行加载后没有 `/bizbridge` 路由 | 该 profile 组合缺 `webServer` 服务（base 不含）：见 `examples/dsh-profile/cordis.patch.yml` 的 webserver 行 |
| 启动报缺 `agents/sessions/sessionPersistence` | profile 缺 `@deepseek-ai/dsh-base`：`dsh plugin --profile <p> add` 引导初始化会自动带上 base |
