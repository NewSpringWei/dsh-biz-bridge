/**
 * 配置归一化测试（§8）：缺省值、覆盖、非法输入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalizeConfig } from '../src/config/config.ts'

test('defaults applied when no config given', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.database.path, DEFAULTS.database.path)
  assert.equal(config.database.journalMode, 'WAL')
  assert.equal(config.database.busyTimeout, 5000)
  assert.equal(config.auth.timestampWindow, 300)
  assert.equal(config.auth.nonceCacheSize, 10000)
  assert.deepEqual(config.auth.clients, [])
  assert.equal(config.scheduler.pollInterval, 2)
  assert.equal(config.scheduler.maxConcurrency, 5)
  assert.equal(config.scheduler.callbackTimeout, 30)
  assert.equal(config.scheduler.maxRetry, 3)
  assert.equal(config.scheduler.retryInterval, 30)
  assert.equal(config.agent.idleTimeout, 10)
  assert.equal(config.http.sseKeepalive, 15)
})

test('deep partial override merges with defaults', () => {
  const config = normalizeConfig({
    database: { path: './var/db.sqlite' },
    scheduler: { pollInterval: 4, maxRetry: 5 },
    agent: { idleTimeout: 0 },
  })
  assert.equal(config.database.path, './var/db.sqlite')
  assert.equal(config.database.journalMode, 'WAL') // 未被覆盖
  assert.equal(config.scheduler.pollInterval, 4)
  assert.equal(config.scheduler.maxRetry, 5)
  assert.equal(config.scheduler.maxConcurrency, 5)
  assert.equal(config.agent.idleTimeout, 0) // 0 = 禁用回收
})

test('clients normalize scope list', () => {
  const config = normalizeConfig({
    auth: {
      clients: [
        { clientId: 'a', publicKey: 'pem-a', scope: ['stream', 'callback'] },
        { clientId: 'admin', publicKey: 'pem-admin', scope: ['admin'] },
      ],
    },
  })
  assert.equal(config.auth.clients.length, 2)
  assert.deepEqual(config.auth.clients[1]?.scope, ['admin'])
})

test('invalid inputs throw', () => {
  assert.throws(() => normalizeConfig({ database: { path: '' } }))
  assert.throws(() => normalizeConfig({ database: { busyTimeout: -1 } }))
  assert.throws(() => normalizeConfig({ auth: { nonceCacheSize: 0 } }))
  assert.throws(() => normalizeConfig({ auth: { clients: [{ clientId: 'x', publicKey: 'p', scope: ['boss'] as never }] } }))
  assert.throws(() => normalizeConfig({ scheduler: { pollInterval: 0 } }))
  assert.throws(() => normalizeConfig({ scheduler: { maxConcurrency: 0 } }))
  assert.throws(() => normalizeConfig({ agent: { idleTimeout: -5 } }))
  assert.throws(() => normalizeConfig({ http: { sseKeepalive: 0 } }))
})
