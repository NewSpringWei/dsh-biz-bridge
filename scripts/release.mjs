/**
 * dsh-biz-bridge 发布打包脚本（release/ 产物生成）。
 *
 * 用法：
 *   1. 先构建：pnpm build          （tsdown 产出 code/lib/index.mjs，命令见 package.json）
 *   2. 打包：node scripts/release.mjs [version]
 *      默认版本取 package.json 的 version；产物写 code/release/dsh-biz-bridge-<version>.tgz
 *
 * 说明：tarball 为 npm 风格（顶层 package/ 前缀）；peer 元数据使用公开 registry
 * 版本区间（与宿主机 DSH 仓库对齐），避免 workspace 协议。tar 使用系统 tar
 * （Windows/macOS 自带 bsdtar，Linux 用 GNU tar）。
 */

import { existsSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const codeRoot = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(codeRoot, 'package.json'), 'utf8'))
const version = process.argv[2] ?? manifest.version
const staging = join(codeRoot, '.release-staging')
const pkgDir = join(staging, 'package')
const outFile = join(codeRoot, 'release', `dsh-biz-bridge-${version}.tgz`)

if (!existsSync(join(codeRoot, 'lib', 'index.mjs'))) {
  console.error('lib/index.mjs 不存在 —— 请先执行构建（pnpm build）')
  process.exit(1)
}

rmSync(staging, { recursive: true, force: true })
mkdirSync(join(pkgDir, 'lib'), { recursive: true })
mkdirSync(join(pkgDir, 'public', 'static'), { recursive: true })

cpSync(join(codeRoot, 'lib', 'index.mjs'), join(pkgDir, 'lib', 'index.mjs'))
cpSync(join(codeRoot, 'public', 'static'), join(pkgDir, 'public', 'static'), { recursive: true })
cpSync(join(codeRoot, 'cordis.patch.yml'), join(pkgDir, 'cordis.patch.yml'))
cpSync(join(codeRoot, 'README.md'), join(pkgDir, 'README.md'))

writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
  name: manifest.name,
  version,
  description: manifest.description,
  type: 'module',
  main: 'lib/index.mjs',
  exports: {
    '.': './lib/index.mjs',
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
  },
  files: ['lib/index.mjs', 'cordis.patch.yml', 'public/static/**', 'README.md'],
  license: 'MIT',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  dependencies: { '@deepseek-ai/schemastery': '^3.18.2' },
  peerDependencies: {
    '@deepseek-ai/cordis': '^4.0.2',
    '@deepseek-ai/dsh-agent': '^0.1.2-rc.1',
    '@deepseek-ai/dsh-session': '^0.1.2-rc.1',
    '@deepseek-ai/dsh-llm': '^0.1.2-rc.1',
    '@deepseek-ai/dsh-session-persistence': '^0.1.2-rc.1',
    '@deepseek-ai/dsh-host-webserver': '^0.1.2-rc.1',
  },
}, null, 2) + '\n')

mkdirSync(dirname(outFile), { recursive: true })
const tar = spawnSync('tar', ['-a', '-cf', outFile, '-C', staging, 'package'], { stdio: 'inherit' })
rmSync(staging, { recursive: true, force: true })
if (tar.status !== 0) {
  console.error('tar 打包失败')
  process.exit(tar.status ?? 1)
}
console.log(`release: ${outFile}`)
