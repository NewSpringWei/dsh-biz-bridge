#!/usr/bin/env node
/**
 * dsh-biz-bridge 便携部署包构建器
 *
 * 把「固定版本的 DSH + 本插件 + Node 运行时 + pnpm」组装成一个可带走的目录。
 * 产物**不进版本库**：它含 Node 与 DSH 安装树（数百 MB），由使用者在本机生成。
 *
 * 只做组装，不做发布。依赖：Node 内置模块（无第三方依赖）。
 *
 * 用法（在开源仓库根 code/ 下执行）：
 *   node tools/bundle/bundle.mjs                      # 按 bundle.config.json 构建（会联网）
 *   node tools/bundle/bundle.mjs --skip-fetch         # 跳过联网步骤，只验证组装（不下载 Node/不装 DSH）
 *   node tools/bundle/bundle.mjs --platform linux-x64 # 交叉构建（下载对应平台 Node）
 *   node tools/bundle/bundle.mjs --node-source /opt/nodejs   # 用本地 Node 目录（离线/内网）
 *   node tools/bundle/bundle.mjs --out /tmp/dist      # 指定产物输出目录
 *   node tools/bundle/bundle.mjs --check dist/<包名>  # 交付前自检：该目录是否仍是干净交付物
 *
 * 退出码：0 成功；1 失败（缺输入或步骤报错）
 *
 * 配置：tools/bundle/bundle.config.json，每一项都可用同名 CLI 参数覆盖（见 README.md）
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))   // code/tools/bundle
const codeRoot = resolve(here, '../..')                // code/（开源仓库根 = 本插件工程根）

// ── CLI ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const flag = name => argv.includes(`--${name}`)

// ── 输出助手 ──────────────────────────────────────────────────────────
const log = m => console.log(`  ${m}`)
const step = m => console.log(`\n[${m}]`)
const warn = m => console.log(`  ⚠️  ${m}`)
const fail = m => {
  console.error(`\n构建失败：${m}`)
  // 半成品不该留在 dist/ 里冒充可交付包：本次已创建的产物目录就地删除。
  if (partialOutDir !== null) {
    try {
      rmSync(partialOutDir, { recursive: true, force: true })
      console.error(`  已删除未完成的产物目录：${partialOutDir}`)
    } catch { /* 删不掉就让它留着，--check 也会拒绝它 */ }
  }
  process.exit(1)
}
/** 本次构建创建的产物目录；失败路径据此回滚。null = 尚未创建。 */
let partialOutDir = null

// ── 配置 ──────────────────────────────────────────────────────────────
const hostPlatform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux'
const hostTag = `${hostPlatform}-${process.arch === 'x64' ? 'x64' : process.arch}`

const configPath = resolve(arg('config', join(here, 'bundle.config.json')))
if (!existsSync(configPath)) fail(`缺配置文件：${configPath}`)
let fc
try {
  fc = JSON.parse(readFileSync(configPath, 'utf8'))
} catch (e) {
  fail(`配置文件不是合法 JSON：${configPath}\n  ${e.message}`)
}

const cfg = {
  dshVersion: arg('dsh-version', fc.dshVersion),
  pnpmVersion: arg('pnpm-version', fc.pnpmVersion),
  nodeVersion: String(arg('node-version', fc.nodeVersion) ?? '').replace(/^v/, ''),
  platform: arg('platform', fc.platform) || hostTag,
  nodeSource: arg('node-source', fc.nodeSource) || '',
  nodeDistMirror: String(arg('node-dist-mirror', fc.nodeDistMirror) || 'https://nodejs.org/dist').replace(/\/+$/, ''),
  out: arg('out', fc.out) || 'dist',
  work: arg('work', fc.work) || '.work',
}
const skipFetch = flag('skip-fetch')
const outRoot = isAbsolute(cfg.out) ? cfg.out : resolve(codeRoot, cfg.out)
const workRoot = isAbsolute(cfg.work) ? cfg.work : resolve(codeRoot, cfg.work)

// ── 交付前自检（--check <目录>）───────────────────────────────────────
const checkTarget = arg('check', undefined)
if (checkTarget !== undefined) {
  checkShippable(resolve(checkTarget))
  process.exit(0)
}

function checkShippable(dir) {
  console.log(`\n[交付前自检] ${dir}\n`)
  if (!existsSync(dir)) fail(`目录不存在：${dir}`)
  const runtimeDir = join(dir, 'runtime')
  const runtimeEntries = existsSync(runtimeDir) ? readdirSync(runtimeDir) : []
  const polluted = runtimeEntries.filter(f => f !== 'README.txt')

  // 启动器按目标平台只有其一：从 VERSION 读平台，再核对对应那一个
  let platform = ''
  const versionFile = join(dir, 'VERSION')
  if (existsSync(versionFile)) {
    const m = readFileSync(versionFile, 'utf8').match(/^平台\s+(\S+)/m)
    if (m) platform = m[1]
  }
  const winTarget = platform.startsWith('win')
  const wantWrapper = platform ? (winTarget ? 'dsh-biz-bridge.cmd' : 'dsh-biz-bridge.sh') : null
  const wantWeb = platform ? (winTarget ? 'dsh-web.cmd' : 'dsh-web.sh') : null
  const wrappers = ['dsh-biz-bridge.cmd', 'dsh-biz-bridge.sh'].filter(f => existsSync(join(dir, f)))
  const strayWrapper = wantWrapper ? wrappers.find(f => f !== wantWrapper) : null

  const missing = ['program', 'runtime', 'readme.md', 'VERSION', 'MANIFEST.sha256']
    .filter(f => !existsSync(join(dir, f)))

  let bad = false
  if (missing.length) { console.error(`  ✗ 缺交付项：${missing.join(', ')}`); bad = true }
  else log('✓ 顶层交付项齐全')

  if (!wrappers.length) { console.error('  ✗ 缺启动器：dsh-biz-bridge.cmd / .sh 都没有'); bad = true }
  else if (wantWrapper && !wrappers.includes(wantWrapper)) {
    console.error(`  ✗ 缺本平台启动器 ${wantWrapper}（VERSION 平台 = ${platform}）`); bad = true
  } else if (strayWrapper) {
    console.error(`  ✗ 混入了非本平台启动器 ${strayWrapper}（平台 ${platform} 应只有 ${wantWrapper}）`); bad = true
  } else log(`✓ 启动器 ${wrappers[0]}（平台 ${platform || '未标注'}）`)

  if (wantWeb && !existsSync(join(dir, wantWeb))) {
    console.error(`  ✗ 缺 web 启动器 ${wantWeb}`); bad = true
  } else if (wantWeb) log(`✓ web 启动器 ${wantWeb}`)

  // 运行期实物：缺了它们，目录"看起来完整"却根本跑不起来。
  // 这一步专治 `--skip-fetch` 产物与半途失败的构建——它们此前能伪装成可交付包。
  const hasNode = ['program/node/node.exe', 'program/node/bin/node'].some(f => existsSync(join(dir, f)))
  const hasCli = existsSync(join(dir, 'program/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'))
  const hasPnpm = ['program/dsh/node_modules/.bin/pnpm.cmd', 'program/dsh/node_modules/.bin/pnpm']
    .some(f => existsSync(join(dir, f)))
  const hasTemplate = existsSync(join(dir, 'program/templates/cordis.patch.yml'))
  const packagesDir = join(dir, 'program/packages')
  const tgzs = existsSync(packagesDir) ? readdirSync(packagesDir).filter(f => f.endsWith('.tgz')) : []
  const incomplete = [
    !hasNode && 'program/node/（自带 Node 运行时）',
    !hasCli && 'program/dsh/（DSH 安装树）',
    !hasPnpm && 'program/dsh/node_modules/.bin/pnpm',
    !hasTemplate && 'program/templates/cordis.patch.yml',
    tgzs.length === 0 && 'program/packages/*.tgz（插件包）',
  ].filter(Boolean)
  if (incomplete.length) {
    console.error('  ✗ 产物不完整，缺运行期实物：')
    for (const item of incomplete) console.error(`      ${item}`)
    console.error('      处置：重新构建；--skip-fetch 的产物只用于验证脚本，不可交付')
    bad = true
  } else log(`✓ 运行期实物齐备（含 ${tgzs.length} 个插件包）`)

  if (!existsSync(runtimeDir)) { console.error('  ✗ 缺 runtime/'); bad = true }
  else if (polluted.length) {
    console.error(`  ✗ runtime/ 已被运行污染，本目录不再是干净交付物：`)
    console.error(`      ${polluted.join(', ')}`)
    console.error('      处置：重新构建，或把本目录当数据目录保留、另出干净产物')
    bad = true
  } else log('✓ runtime/ 干净（只有 README.txt）')

  if (bad) { console.error('\n自检未通过。\n'); process.exit(1) }
  console.log('\n自检通过：该目录可打包交付。\n')
}

// ── 清理（--clean）────────────────────────────────────────────────────
// 本次构建的产物目录在下面会被 rmSync 重建，所以它自己不会脏。会脏的是**外面**：
//   dist/  可能留着别的版本、别的平台、以及之前打好的 zip
//   .work/ 会累积多个 Node 版本、npm 缓存、和各种 --out 试跑残留
// 交付前想确保"只有这一次构建的东西"时，用 --clean 先清空两者再构建。
if (flag('clean')) {
  for (const target of [outRoot, workRoot]) {
    if (!existsSync(target)) { log(`跳过（不存在）：${target}`); continue }
    const count = walk(target).length
    rmSync(target, { recursive: true, force: true })
    log(`已清空 ${target}（${count} 个文件）`)
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else if (entry.isFile()) out.push(p)
  }
  return out
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function writeText(file, text, { crlf = false } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, crlf ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8')
}

async function download(url, dest) {
  let res
  try {
    res = await fetch(url)
  } catch (e) {
    fail(`下载失败：${url}\n  ${e.message}\n  （若在受限网络内，可用 --node-source 指定本地 Node 目录，或改 nodeDistMirror）`)
  }
  if (!res.ok) fail(`下载失败 HTTP ${res.status} ${res.statusText}\n  ${url}`)
  mkdirSync(dirname(dest), { recursive: true })
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

async function fetchText(url) {
  let res
  try {
    res = await fetch(url)
  } catch (e) {
    fail(`下载失败：${url}\n  ${e.message}`)
  }
  if (!res.ok) fail(`下载失败 HTTP ${res.status} ${res.statusText}\n  ${url}`)
  return res.text()
}

function extractArchive(archive, destDir) {
  mkdirSync(destDir, { recursive: true })
  const run = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' })
  let r
  if (archive.endsWith('.zip')) {
    // Windows 10+ 自带 bsdtar，可直接解 zip；失败退回 PowerShell
    r = run('tar', ['-xf', archive, '-C', destDir])
    if (r.status !== 0 && process.platform === 'win32') {
      log('tar 解 zip 失败，改用 PowerShell Expand-Archive')
      const q = s => `'${s.replace(/'/g, "''")}'`
      r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath ${q(archive)} -DestinationPath ${q(destDir)} -Force`])
    }
  } else {
    r = run('tar', [archive.endsWith('.tar.xz') ? '-xJf' : '-xzf', archive, '-C', destDir])
  }
  if (r.status !== 0) {
    fail(`解压失败（退出码 ${r.status}）：${archive}\n`
      + `  需要系统具备 tar${archive.endsWith('.tar.xz') ? ' 与 xz' : ''} 命令`)
  }
}

/** 目标平台对应的官方 Node 包名（Node 的平台命名与本构建器的 platform 取值一致） */
function nodeArchiveName() {
  if (!cfg.nodeVersion) fail('未配置 nodeVersion（下载 Node 必须钉确切版本；或用 nodeSource 指定本地目录）')
  const ext = cfg.platform.startsWith('win') ? 'zip' : cfg.platform.startsWith('darwin') ? 'tar.gz' : 'tar.xz'
  return `node-v${cfg.nodeVersion}-${cfg.platform}.${ext}`
}

// ── 输入解析 ──────────────────────────────────────────────────────────
step('解析配置')
const manifest = JSON.parse(readFileSync(join(codeRoot, 'package.json'), 'utf8'))
const pluginVersion = manifest.version
const pluginTgz = join(codeRoot, 'release', `dsh-biz-bridge-${pluginVersion}.tgz`)
const templateDir = join(here, 'templates')

log(`配置来源   ${configPath}`)
log(`插件版本   ${pluginVersion}`)
log(`平台       ${cfg.platform}${cfg.platform === hostTag ? '（宿主）' : '（交叉）'}`)
log(`DSH 版本   ${cfg.dshVersion}`)
log(`pnpm 版本  ${cfg.pnpmVersion}`)
log(`Node 版本  ${cfg.nodeVersion || '(由 nodeSource 决定)'}`)
log(`Node 来源  ${cfg.nodeSource || `${cfg.nodeDistMirror}/v${cfg.nodeVersion}`}`)
log(`产物目录   ${outRoot}`)
log(`中间物目录 ${workRoot}`)
if (skipFetch) log('模式       --skip-fetch（跳过联网步骤）')

failIf(!existsSync(pluginTgz),
  `插件包不存在：${pluginTgz}\n  先执行：pnpm install && pnpm build && npm run release`)
failIf(!existsSync(join(templateDir, 'cordis.patch.yml')), `缺模板：${templateDir}`)

function failIf(cond, m) { if (cond) fail(m) }

const pkgName = `dsh-biz-bridge-${pluginVersion}-${cfg.platform}`
const outDir = join(outRoot, pkgName)
partialOutDir = outDir

// ── 清理并建骨架 ──────────────────────────────────────────────────────
step('建立目录骨架')
if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
for (const d of ['program/node', 'program/dsh', 'program/packages', 'program/templates', 'runtime']) {
  mkdirSync(join(outDir, d), { recursive: true })
}
log('program/{node,dsh,packages,templates} + runtime/')

// ── Node 运行时 ───────────────────────────────────────────────────────
step('Node 运行时')
let nodeVersion = '(未提供)'
const nodeDest = join(outDir, 'program/node')

if (skipFetch) {
  log('跳过（--skip-fetch）')
} else if (cfg.nodeSource) {
  failIf(!existsSync(cfg.nodeSource), `nodeSource 不存在：${cfg.nodeSource}`)
  const exeRel = ['node.exe', join('bin', 'node'), 'node'].find(p => existsSync(join(cfg.nodeSource, p)))
  failIf(!exeRel, `nodeSource 里找不到 node 可执行文件（试过 node.exe / bin/node / node）：${cfg.nodeSource}`)
  const probe = spawnSync(join(cfg.nodeSource, exeRel), ['-v'], { encoding: 'utf8' })
  nodeVersion = probe.status === 0 ? String(probe.stdout).trim() : `v${cfg.nodeVersion || '?'}`
  cpSync(cfg.nodeSource, nodeDest, { recursive: true })
  log(`从 ${cfg.nodeSource} 复制 → ${nodeVersion}`)
} else {
  const file = nodeArchiveName()
  const base = `${cfg.nodeDistMirror}/v${cfg.nodeVersion}`
  const cacheDir = join(workRoot, 'cache')
  const archive = join(cacheDir, file)

  if (existsSync(archive)) {
    log(`复用已下载的包：${archive}`)
  } else {
    log(`下载 ${base}/${file}`)
    await download(`${base}/${file}`, archive)
  }

  // 校验和（SHASUMS256.txt 与包同源，属完整性校验，非独立签名校验）
  const sums = await fetchText(`${base}/SHASUMS256.txt`)
  const line = sums.split(/\r?\n/).find(l => l.trim().split(/\s+/).slice(-1)[0] === file)
  failIf(!line, `SHASUMS256.txt 中找不到 ${file}`)
  const expected = line.trim().split(/\s+/)[0]
  const actual = sha256File(archive)
  if (expected !== actual) {
    rmSync(archive, { force: true })
    fail(`校验和不匹配，已删除下载文件\n  期望 ${expected}\n  实际 ${actual}\n  重跑会重新下载`)
  }
  log(`校验和 OK  ${actual.slice(0, 16)}…`)

  // 解压（幂等：以 .ok 标记解压完成）
  const extractDir = join(cacheDir, `x-${file}`)
  if (!existsSync(join(extractDir, '.ok'))) {
    rmSync(extractDir, { recursive: true, force: true })
    extractArchive(archive, extractDir)
    writeFileSync(join(extractDir, '.ok'), 'ok\n')
  }
  const roots = readdirSync(extractDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('node-v')).map(d => d.name)
  failIf(roots.length !== 1, `解压结果异常，期望唯一 node-v* 目录，实际：${roots.join(', ') || '(空)'}`)
  cpSync(join(extractDir, roots[0]), nodeDest, { recursive: true })
  nodeVersion = `v${cfg.nodeVersion}`
  log(`解压并复制 → ${nodeVersion}`)
}

// 自带运行时必须随附许可证（对外分发合规）
if (existsSync(nodeDest) && readdirSync(nodeDest).length > 0) {
  const hasLicense = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].some(f => existsSync(join(nodeDest, f)))
  if (!hasLicense) {
    warn('program/node 内未见 LICENSE —— 对外分发前请补上 Node 的许可证与第三方声明')
    warn('（官方 Node 包自带 LICENSE；用 nodeSource 复制宿主安装目录时可能缺失）')
  } else {
    log('LICENSE 已随运行时带入')
  }
}

// ── DSH 安装树 + pnpm ─────────────────────────────────────────────────
step('DSH 安装树 + pnpm')
if (skipFetch) {
  log(`跳过（--skip-fetch）。目标：npm install @deepseek-ai/dsh@${cfg.dshVersion} pnpm@${cfg.pnpmVersion}`)
} else {
  // 缓存放 .work/npm-cache：不依赖构建机的全局 npm 缓存，也让受限环境下可运行。
  // --ignore-scripts：DSH 依赖闭包是纯 JS（原生件走预编译平台包），无需安装脚本；
  // 跳过它同时让构建更可复现，不引入安装期的任意代码执行。
  const npmCache = join(workRoot, 'npm-cache')
  mkdirSync(npmCache, { recursive: true })

  // 先写入安装根的 package.json：npm 会向上找最近的 package.json 当作项目根，
  // 若找到的是本仓库自己的（且那里的 node_modules 是 pnpm 布局），arborist 在依赖
  // 去重阶段会抛 TypeError。钉住本目录即可让安装与仓库环境无关。
  const dshDir = join(outDir, 'program/dsh')
  writeText(join(dshDir, 'package.json'),
    JSON.stringify({ name: 'dsh-bundle-runtime', version: '0.0.0', private: true }, null, 2) + '\n')

  const installArgs = ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--cache', npmCache,
    `@deepseek-ai/dsh@${cfg.dshVersion}`, `pnpm@${cfg.pnpmVersion}`]
  // 首选 Node 自带的 npm CLI（与当前 node 同目录）：不经 shell，因此既避开 Windows 上
  // npm.cmd 的 %dp0% 解析问题，也不会触发 Node 的 DEP0190 弃用告警混进交付日志。
  // 找不到时退回 PATH 上的 npm；Windows 上它是 npm.cmd，必须经 shell 才能启动。
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const r = existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...installArgs], { cwd: dshDir, stdio: 'inherit' })
    : spawnSync('npm', installArgs, {
      cwd: dshDir, stdio: 'inherit', shell: process.platform === 'win32',
    })
  failIf(r.status !== 0, 'npm install 失败（检查网络 / registry 可达性）')
  const cli = join(outDir, 'program/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  failIf(!existsSync(cli), `安装后缺 CLI 入口：${cli}`)
  log(`已装：@deepseek-ai/dsh@${cfg.dshVersion} + pnpm@${cfg.pnpmVersion}`)
}

// ── 插件包与模板 ──────────────────────────────────────────────────────
step('插件包与模板')
cpSync(pluginTgz, join(outDir, 'program/packages', `dsh-biz-bridge-${pluginVersion}.tgz`))
log(`插件包 → program/packages/dsh-biz-bridge-${pluginVersion}.tgz`)
for (const f of readdirSync(templateDir)) {
  cpSync(join(templateDir, f), join(outDir, 'program/templates', f))
  log(`模板   → program/templates/${f}`)
}
writeText(join(outDir, 'runtime/README.txt'), `本目录是数据根：DSH_HOME 与插件的 runtime.path 同指此处。
首次启动前只有本文件；其余目录由启动脚本与首次运行生成。

  clients/                业务方 client 公钥表 —— 插件数据，运维唯一要动的目录
    clients.json            元数据：[{ clientId, scope, enabled }]
    <clientId>.pem          该 client 的公钥（SPKI PEM，整段原文粘贴）
                          改动即时生效，**不需要重启**；enabled:false 即停用该 client
  data/                   插件 SQLite（任务 / 任务日志 / 结果）
  logs/                   插件运行日志（按天轮转）
  workspace/<clientId>/   各业务 client 的 agent 会话工作目录
  profiles/               DSH profile（bizbridge 服务与 web 各一个）
  sessions/ storages/     会话与存储（DSH 侧）
  settings.yaml           模型等设置（DSH 侧）—— 请用 dsh-web 配置，勿手工编辑
  .credentials.yaml       模型凭据（DSH 侧）—— 请用 dsh-web 配置，勿手工编辑

迁移 / 备份：整目录拷贝本目录即可。

注意：本目录一旦被运行过（出现 clients/ data/ logs/ profiles/ 等），本包即不再是
干净交付物。要产出可交付的包，请在副本上做验收。
`)

// ── wrapper ───────────────────────────────────────────────────────────
step('wrapper（启动器）')
const isWinTarget = cfg.platform.startsWith('win')

// 只写目标平台的那一个。另一平台的启动器在本包里必然跑不起来
// （Windows 用 program/node/node.exe，类 Unix 用 program/node/bin/node），
// 放进去只会让运维猜该执行哪个。
//
// 启动器是**一键启动**的：无参数时自己完成部署（首次 add / 升级后按 tgz 名重装）
// 与配置播种，然后启动；带参数时原样透传给 dsh，作为技术人员的逃生口。
// 运维因此不需要知道 DSH_HOME、`./` 前缀、profile 这些概念。
//
// 消息一律用 ASCII：cmd 解析批处理的编码取决于控制台代码页，
// 在 .cmd 里写中文会在非中文代码页下变成乱码。中文说明放 readme.md。
if (isWinTarget) {
  writeText(join(outDir, 'dsh-biz-bridge.cmd'), String.raw`@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0"
set "DSH_HOME=%ROOT%runtime"
set "PATH=%ROOT%program\node;%ROOT%program\dsh\node_modules\.bin;%PATH%"
cd /d "%ROOT%"
set "NODE=%ROOT%program\node\node.exe"
set "CLI=%ROOT%program\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
set "PROFILE=bizbridge"
set "PROFDIR=%ROOT%runtime\profiles\%PROFILE%"

rem ---- with arguments: pass straight through to dsh --------------------
if not "%~1"=="" (
  "%NODE%" "%CLI%" %*
  exit /b %ERRORLEVEL%
)

rem ---- locate the bundled plugin package -------------------------------
set "TGZ="
set "TGZNAME="
for %%f in ("%ROOT%program\packages\*.tgz") do (
  set "TGZ=%%~ff"
  set "TGZNAME=%%~nxf"
)
if not defined TGZ (
  echo [bizbridge] ERROR: no plugin package found under program\packages\
  exit /b 1
)
rem plugin version, derived from the package name: dsh-biz-bridge-<ver>.tgz
set "VER=!TGZNAME:dsh-biz-bridge-=!"
set "VER=!VER:.tgz=!"

rem ---- first run, or the profile is still pinned to another version ----
set "FRESH="
if not exist "%PROFDIR%\package.json" set "FRESH=1"
set "NEED_ADD="
if defined FRESH (
  set "NEED_ADD=1"
) else (
  findstr /c:"!TGZNAME!" "%PROFDIR%\package.json" >nul 2>&1
  if errorlevel 1 set "NEED_ADD=1"
)

if defined NEED_ADD (
  rem On upgrade the profile still pins the previous tgz path, which no longer
  rem exists after program/ was replaced — pnpm would fail resolving it before
  rem it ever installs the new one. Drop the stale entry first.
  if not defined FRESH (
    echo [bizbridge] removing stale plugin entry ...
    "%NODE%" "%CLI%" plugin --profile %PROFILE% remove dsh-biz-bridge >nul 2>&1
  )
  echo [bizbridge] installing plugin into profile ...
  "%NODE%" "%CLI%" plugin --profile %PROFILE% add "!TGZ!"
  rem dsh plugin add exits 0 even when pnpm fails, so verify the result instead
  rem of trusting its exit code.
  "%NODE%" -e "process.exit(require(require('path').join(process.argv[1],'node_modules','dsh-biz-bridge','package.json')).version===process.argv[2]?0:1)" "%PROFDIR%" "!VER!" 2>nul
  if errorlevel 1 (
    echo [bizbridge] ERROR: plugin !VER! is not installed in the profile.
    echo [bizbridge]   see the pnpm output above.
    exit /b 1
  )
)

rem ---- seed configuration only when there is nothing to overwrite ------
set "SEED_CFG="
if defined FRESH set "SEED_CFG=1"
if not exist "%PROFDIR%\cordis.patch.yml" set "SEED_CFG=1"
if defined SEED_CFG (
  copy /y "%ROOT%program\templates\cordis.patch.yml" "%PROFDIR%\cordis.patch.yml" >nul
  echo [bizbridge] profile config written: %PROFDIR%\cordis.patch.yml
  echo [bizbridge]   set webServer port in it; add clients under runtime\clients\
)
echo [bizbridge] starting ...
"%NODE%" "%CLI%" --profile %PROFILE%
exit /b %ERRORLEVEL%
`, { crlf: true })
  log('dsh-biz-bridge.cmd（CRLF，一键启动）')
} else {
  writeText(join(outDir, 'dsh-biz-bridge.sh'), `#!/usr/bin/env sh
# dsh-biz-bridge 便携包启动器
#   无参数 = 确保部署完成（首次 add / 换版本重装）并启动
#   带参数 = 原样透传给 dsh
ROOT="$(cd "$(dirname "$0")" && pwd)"
export DSH_HOME="$ROOT/runtime"
export PATH="$ROOT/program/node/bin:$ROOT/program/dsh/node_modules/.bin:$PATH"
cd "$ROOT"
NODE="$ROOT/program/node/bin/node"
CLI="$ROOT/program/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
PROFILE=bizbridge
PROFDIR="$ROOT/runtime/profiles/$PROFILE"

if [ "$#" -gt 0 ]; then
  exec "$NODE" "$CLI" "$@"
fi

TGZ="$(ls "$ROOT/program/packages/"*.tgz 2>/dev/null | head -n 1)"
if [ -z "$TGZ" ]; then
  echo "[bizbridge] ERROR: no plugin package found under program/packages/" >&2
  exit 1
fi
TGZNAME="$(basename "$TGZ")"

FRESH=""
[ -f "$PROFDIR/package.json" ] || FRESH=1
NEED_ADD=""
if [ -n "$FRESH" ]; then
  NEED_ADD=1
elif ! grep -q "$TGZNAME" "$PROFDIR/package.json" 2>/dev/null; then
  NEED_ADD=1
fi
VER="$(basename "$TGZ" .tgz)"
VER="\${VER#dsh-biz-bridge-}"
if [ -n "$NEED_ADD" ]; then
  # On upgrade the profile still pins the previous tgz path, which no longer
  # exists after program/ was replaced. Drop the stale entry first.
  if [ -z "$FRESH" ]; then
    echo "[bizbridge] removing stale plugin entry ..."
    "$NODE" "$CLI" plugin --profile "$PROFILE" remove dsh-biz-bridge >/dev/null 2>&1 || true
  fi
  echo "[bizbridge] installing plugin into profile ..."
  "$NODE" "$CLI" plugin --profile "$PROFILE" add "$TGZ"
  # \`dsh plugin add\` exits 0 even when pnpm fails, so verify the result instead.
  if ! "$NODE" -e "process.exit(require(require('path').join(process.argv[1],'node_modules','dsh-biz-bridge','package.json')).version===process.argv[2]?0:1)" "$PROFDIR" "$VER" 2>/dev/null; then
    echo "[bizbridge] ERROR: plugin $VER is not installed in the profile." >&2
    exit 1
  fi
fi

if [ -n "$FRESH" ] || [ ! -f "$PROFDIR/cordis.patch.yml" ]; then
  cp "$ROOT/program/templates/cordis.patch.yml" "$PROFDIR/cordis.patch.yml"
  echo "[bizbridge] profile config written: $PROFDIR/cordis.patch.yml"
  echo "[bizbridge]   set webServer port in it; add clients under runtime/clients/"
fi
echo "[bizbridge] starting ..."
exec "$NODE" "$CLI" --profile "$PROFILE"
`)
  if (process.platform === 'win32') {
    log('dsh-biz-bridge.sh（LF）—— 在 Windows 上构建，未设执行位；目标机需 chmod +x')
  } else {
    try { chmodSync(join(outDir, 'dsh-biz-bridge.sh'), 0o755) } catch { /* 某些文件系统不支持 */ }
    log('dsh-biz-bridge.sh（LF +x，一键启动）')
  }
}

// dsh-web：启动**同一份包内**的 dsh web，用于配置模型与凭据。
// 与 dsh-biz-bridge 同一套约定（包内 Node + 包内 CLI + DSH_HOME=包内 runtime），
// 所以两个 profile 共享 runtime/ 下的 settings.yaml 与 .credentials.yaml ——
// 在 web 里配的模型，桥那边直接读得到（设置与凭据都热生效，无需重启）。
// 它不装载桥插件，只是同一台机器上的第二个浏览器面。
if (isWinTarget) {
  writeText(join(outDir, 'dsh-web.cmd'), String.raw`@echo off
setlocal
set "ROOT=%~dp0"
set "DSH_HOME=%ROOT%runtime"
set "PATH=%ROOT%program\node;%ROOT%program\dsh\node_modules\.bin;%PATH%"
cd /d "%ROOT%"
set "NODE=%ROOT%program\node\node.exe"
set "CLI=%ROOT%program\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
rem 避开 DSH 默认的 3080：桥在 42731，web 面固定 42730。
rem --port 放在 %* 之前，所以传参仍可覆盖（Commander 后者优先）。
set "PORT=42730"

echo [bizbridge] starting dsh web ...
echo [bizbridge]   configure models and credentials here; the bridge service reads them.
echo [bizbridge]   open http://127.0.0.1:%PORT%
echo [bizbridge]   NOTE: this surface also exposes an agent console - localhost only.
"%NODE%" "%CLI%" --profile web --port %PORT% %*
exit /b %ERRORLEVEL%
`, { crlf: true })
  log('dsh-web.cmd（CRLF）')
} else {
  writeText(join(outDir, 'dsh-web.sh'), `#!/usr/bin/env sh
# 启动同一份包内的 dsh web，用于配置模型与凭据（与 dsh-biz-bridge.sh 共享 DSH_HOME）。
ROOT="$(cd "$(dirname "$0")" && pwd)"
export DSH_HOME="$ROOT/runtime"
export PATH="$ROOT/program/node/bin:$ROOT/program/dsh/node_modules/.bin:$PATH"
cd "$ROOT"
# 避开 DSH 默认的 3080：桥在 42731，web 面固定 42730。
# --port 放在 "$@" 之前，所以传参仍可覆盖（Commander 后者优先）。
PORT=42730
echo "[bizbridge] starting dsh web ..."
echo "[bizbridge]   configure models and credentials here; the bridge service reads them."
echo "[bizbridge]   open http://127.0.0.1:$PORT"
echo "[bizbridge]   NOTE: this surface also exposes an agent console - localhost only."
exec "$ROOT/program/node/bin/node" "$ROOT/program/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile web --port "$PORT" "$@"
`)
  if (process.platform === 'win32') {
    log('dsh-web.sh（LF）—— 在 Windows 上构建，未设执行位；目标机需 chmod +x')
  } else {
    try { chmodSync(join(outDir, 'dsh-web.sh'), 0o755) } catch { /* 某些文件系统不支持 */ }
    log('dsh-web.sh（LF +x）')
  }
}

// ── 手册 ──────────────────────────────────────────────────────────────
step('部署手册')
writeText(join(outDir, 'readme.md'), `# dsh-biz-bridge 便携部署（${pluginVersion} · ${cfg.platform}）

## 前置

目标机器**无需**预装 Node / DSH / pnpm —— 本包自带。

## 步骤

三个动作：**跑桥 → 用 dsh-web 配模型 → 配 client 公钥**。
首次安装、升级重装、配置播种都由启动脚本自动完成。

### ① 启动桥服务

\`\`\`bash
# Windows
dsh-biz-bridge.cmd
# Linux / macOS
./dsh-biz-bridge.sh
\`\`\`

第一次运行脚本会做三件事，然后启动服务：

1. 把插件装进 profile（内部调用 \`dsh plugin add\`，用**绝对路径**，不涉及 \`./\` 前缀）
2. 把 \`program/templates/cordis.patch.yml\` 播种为 profile 配置
3. 启动服务

**什么都没配也能启动**：公钥表为空时全部 API 请求返回 401、只有静态页可达（fail-closed），
所以先跑起来是安全的。启动日志出现 \`activated\` 即成功。

### ② 配模型 —— 用 dsh-web（**不要手工改配置文件**）

\`\`\`bash
# Windows
dsh-web.cmd
# Linux / macOS
./dsh-web.sh
\`\`\`

等它起来后打开 \`http://127.0.0.1:42730\`，在设置里配置 provider / model / API Key。

> 端口固定为 **42730**（DSH 默认的 3080 已避开），由启动脚本以 \`--port\` 传入；
> 自己传 \`--port\` 可覆盖。

它启动的是**包内这套 DSH**（不是机器上装的那套），与本服务共用同一个 \`runtime/\` ——
所以在这里配好的模型与凭据，桥服务直接读得到，**且改动即时生效、无需重启**。

> ⚠️ **dsh-web 同时会暴露一个 agent 操作台**（它装载 dsh-base：bash / pwsh / 文件系统 / 沙箱）。
> 所以它只监听 \`127.0.0.1\`，**用完请关掉**，不要对外暴露。
>
> 不配模型的症状：**服务能启动、接口全正常，但每个请求都失败**，报 \`has no provider/model\`。

### ③ 配业务方 client 公钥

公钥表在 \`runtime/clients/\`，**改动即时生效、不需要重启**：

\`\`\`text
runtime/clients/clients.json     [{ "clientId": "...", "scope": [...], "enabled": true }]
runtime/clients/<clientId>.pem   该 client 的公钥（整段原文粘贴）
\`\`\`

**公钥从哪来**：起服务后打开 \`http://127.0.0.1:42731/bizbridge/static/utils.html\`
（静态页无需认证、纯本地运算、不发任何网络请求）生成密钥对，把它给出的**公钥**
存成 \`runtime/clients/<clientId>.pem\`，并在 \`clients.json\` 里登记一行。

> 字段与格式说明见 \`runtime/README.txt\`（JSON 本身写不了注释）。
> \`enabled: false\` 即停用该 client，不必删文件。

### 需要手工执行 dsh 时（技术人员）

两个脚本**带参数时都会原样透传**给 dsh：

\`\`\`bash
dsh-biz-bridge.cmd --help
dsh-biz-bridge.cmd plugin --profile bizbridge list
dsh-web.cmd --help
\`\`\`

> ⚠️ \`cordis.patch.yml\` 里 \`webServer\` 那一段**不要删**：插件的 HTTP 路由挂在它上面，
> 缺了它宿主会报 \`pending (waiting for service: webServer)\` 并退出。
> 脚本**不会覆盖**你已经改过的配置，所以反复运行是安全的。

## 对外服务

默认只监听 \`127.0.0.1\`。要服务局域网/外部：

1. 改配置 \`host: "0.0.0.0"\` + 防火墙放行，或
2. **前置 nginx（推荐）**。注意 SSE —— 插件 stream 的语义是**客户端断连即取消**：

\`\`\`nginx
location /bizbridge/ {
    proxy_pass http://127.0.0.1:42731;
    proxy_http_version 1.1;
    proxy_buffering off;          # 否则流被缓冲
    proxy_read_timeout 3600s;     # 长任务可达分钟级
    proxy_set_header Connection '';
    # 关键：下游断连须传播到上游，否则取消语义失效 → 业务方已放弃、agent 仍在烧 token 且不报错
}
\`\`\`

## 回调不通常见排查

插件会主动 POST 到业务方 \`callback_url\`（出站方向）。网络不归插件管，但插件让失败可见：

任务记为 \`callback_failed\`，按 \`maxRetry\`/\`retryInterval\` 重试，详情与 \`tasks/{id}/logs\` 有记录。

## 交付前自检（重要）

确认本目录 \`runtime/\` 下**只有 README.txt**。

一旦在本目录**原地**运行过启动脚本，\`runtime/\` 就会长出 \`profiles/\` \`.credentials.yaml\`
\`data/\` \`logs/\` —— 此时本目录**不再是干净交付物**，而**没有任何标记能看出来**。
所以：验收请在**副本**上做；打包带走前先确认 \`runtime/\` 是干净的。

## 升级

替换 \`program/\`，\`runtime/\` 原地保留（配置与数据都在 runtime 下），然后**重新运行启动脚本**。

脚本会比对 profile 里记录的插件包名与随包 tgz 的名称：**不一致就自动重装**，
不需要手工执行 \`dsh plugin add\`，也不会碰你改过的配置。
`)

// ── VERSION / MANIFEST ────────────────────────────────────────────────
step('VERSION 与 MANIFEST')
writeText(join(outDir, 'VERSION'), `插件     dsh-biz-bridge ${pluginVersion}
DSH      ${cfg.dshVersion}
pnpm     ${cfg.pnpmVersion}
Node     ${nodeVersion}
平台     ${cfg.platform}
构建时间 ${new Date().toISOString()}
主机     ${process.platform}-${process.arch}
`)

const files = walk(outDir).filter(f => !f.endsWith('MANIFEST.sha256')).sort()
writeText(join(outDir, 'MANIFEST.sha256'),
  files.map(f => `${sha256File(f)}  ${f.slice(outDir.length + 1).replace(/\\/g, '/')}`).join('\n') + '\n')
log(`${files.length} 个文件已入 MANIFEST`)

// ── 报告 ──────────────────────────────────────────────────────────────
step('完成')
log(`产物：${outDir}`)
if (skipFetch) {
  console.log('\n⚠️  本次为 --skip-fetch，以下目录为空，需重跑以补齐：')
  console.log('     program/node   （Node 运行时）')
  console.log('     program/dsh    （DSH 安装树 + pnpm）')
  console.log('   脚本结构与组装逻辑已验证；补齐后即为可交付压缩包。')
}
console.log('\n交付前自检：')
console.log(`  node tools/bundle/bundle.mjs --check "${outDir}"`)
console.log('\n压缩整个目录即可带走（落在 dist/ 内，该目录已被 gitignore）：')
console.log(`  tar -a -cf "${join(outRoot, `${pkgName}.zip`)}" -C "${outRoot}" "${pkgName}"`)
