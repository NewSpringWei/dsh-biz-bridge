/**
 * 配置归一化与磁盘布局测试（§8）：
 * 单一 runtime 根 schema（草创期破坏性改版）——defaults、派生 data/logs/workspace、
 * client 工作区目录、非法输入校验。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join, isAbsolute } from 'node:path'
import { DEFAULTS, normalizeConfig, resolveRuntimeLayout, clientWorkspaceDir } from '../src/config/config.ts'
import { Config } from '../src/index.ts'

const ORIGINAL_CWD = process.cwd()

test('attachments: 开关与上限缺省、归一化、非法值拒绝', () => {
  const c = normalizeConfig(undefined)
  assert.equal(c.attachments.enabled, true)
  assert.equal(c.attachments.maxItems, 10)
  assert.equal(c.attachments.maxFileBytes, 32 * 1024 * 1024)
  assert.equal(c.attachments.maxTotalBytes, 64 * 1024 * 1024)
  assert.equal(c.attachments.fetchTimeout, 30)
  assert.deepEqual(c.attachments.allowedHosts, [])
  assert.deepEqual(c.attachments.outbound.exclude, ['attachments', 'node_modules', '.git', '.ssh', '.aws', '.kube', '.gnupg', '.docker'])

  const custom = normalizeConfig({
    attachments: {
      enabled: false,
      maxItems: 3,
      allowedHosts: ['files.biz.example.com'],
      outbound: { enabled: false, maxFiles: 2, exclude: ['tmp'] },
    },
  })
  assert.equal(custom.attachments.enabled, false)
  assert.equal(custom.attachments.maxItems, 3)
  assert.equal(custom.attachments.maxFileBytes, DEFAULTS.attachments.maxFileBytes)
  assert.deepEqual(custom.attachments.allowedHosts, ['files.biz.example.com'])
  assert.equal(custom.attachments.outbound.enabled, false)
  assert.equal(custom.attachments.outbound.maxFiles, 2)
  assert.equal(custom.attachments.outbound.maxFileBytes, 32 * 1024 * 1024)
  assert.deepEqual(custom.attachments.outbound.exclude, ['tmp'])

  assert.throws(() => normalizeConfig({ attachments: { maxItems: 0 } }), /attachments\.maxItems/)
  assert.throws(() => normalizeConfig({ attachments: { fetchTimeout: 0 } }), /attachments\.fetchTimeout/)
  assert.throws(() => normalizeConfig({ attachments: { enabled: 'yes' as unknown as boolean } }), /attachments\.enabled/)
  assert.throws(() => normalizeConfig({ attachments: { allowedHosts: [''] } }), /allowedHosts/)
  assert.throws(() => normalizeConfig({ attachments: { outbound: { maxFiles: 0 } } }), /outbound\.maxFiles/)
  assert.throws(() => normalizeConfig({ attachments: { outbound: { exclude: [''] } } }), /outbound\.exclude/)
})

test('attachments: schema 缺省值与 DEFAULTS 双源一致（防漂移）', () => {
  // index.ts 的 schemastery schema 与 config.ts 的 DEFAULTS 是两处声明，必须一致
  const fromSchema = Config({}) as { attachments: unknown }
  assert.deepEqual(JSON.parse(JSON.stringify(fromSchema.attachments)), JSON.parse(JSON.stringify(DEFAULTS.attachments)))
})

test('defaults applied when no config given', () => {
  const c = normalizeConfig(undefined)
  assert.equal(c.runtime.path, './runtime')
  assert.equal(c.database.journalMode, 'WAL')
  assert.equal(c.database.busyTimeout, 5000)
  assert.equal(c.auth.timestampWindow, 300)
  assert.equal(c.scheduler.pollInterval, 2)
  assert.equal(c.http.sseKeepalive, 15)
  // 旧键已移除：不再有 database.path / logging
  assert.ok(!('path' in c.database))
  assert.ok(!('logging' in c))
})

test('deep partial override merges with defaults', () => {
  const c = normalizeConfig({
    runtime: { path: '/tmp/bridge-runtime' },
    database: { busyTimeout: 999 },
    scheduler: { maxConcurrency: 3 },
  })
  assert.equal(c.runtime.path, '/tmp/bridge-runtime')
  assert.equal(c.database.busyTimeout, 999)
  assert.equal(c.database.journalMode, 'WAL')
  assert.equal(c.scheduler.maxConcurrency, 3)
  assert.equal(c.scheduler.pollInterval, 2)
})

test('runtime layout derivation: relative base under cwd, fixed children', () => {
  const layout = resolveRuntimeLayout('./runtime')
  assert.ok(isAbsolute(layout.root))
  assert.equal(layout.root, resolve(ORIGINAL_CWD, 'runtime'))
  assert.equal(layout.dataDir, join(layout.root, 'data'))
  assert.equal(layout.logsDir, join(layout.root, 'logs'))
  assert.equal(layout.workspaceDir, join(layout.root, 'workspace'))
  assert.equal(layout.dbFile, join(layout.dataDir, 'dsh-biz-bridge.db'))
  assert.equal(clientWorkspaceDir(layout.workspaceDir, 'biz-a'), join(layout.workspaceDir, 'biz-a'))
})

test('runtime layout derivation: absolute root passthrough', () => {
  const layout = resolveRuntimeLayout('D:\\rt')
  assert.equal(layout.root, isAbsolute('D:\\rt') ? 'D:\\rt' : resolve(ORIGINAL_CWD, 'D:\\rt'))
})

test('invalid inputs throw', () => {
  assert.throws(() => normalizeConfig({ runtime: { path: '' } }))
  assert.throws(() => normalizeConfig({ runtime: { path: 42 as unknown as string } }))
  assert.throws(() => normalizeConfig({ database: { busyTimeout: -1 } }))
  assert.throws(() => normalizeConfig({ database: { journalMode: '' } }))
  assert.throws(() => normalizeConfig({ auth: { timestampWindow: -1 } }))
  assert.throws(() => normalizeConfig({ auth: { clients: [{ clientId: 'x', publicKey: '' }] } }))
  assert.throws(() => normalizeConfig({ scheduler: { pollInterval: 0 } }))
  assert.throws(() => normalizeConfig({ http: { sseKeepalive: 0 } }))
})
