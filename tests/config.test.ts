/**
 * 配置归一化与磁盘布局测试（§8）：
 * 单一 runtime 根 schema（草创期破坏性改版）——defaults、派生 data/logs/workspace、
 * client 工作区目录、非法输入校验。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join, isAbsolute } from 'node:path'
import { normalizeConfig, resolveRuntimeLayout, clientWorkspaceDir } from '../src/config/config.ts'

const ORIGINAL_CWD = process.cwd()

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
