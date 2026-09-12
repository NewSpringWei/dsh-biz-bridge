/**
 * client 公钥表（`<runtime>/clients/`）测试：
 * 目录形态装载、降级语义（解析失败不清空）、指纹变化、一次性迁移。
 *
 * 关键不变量：**一个笔误不能让所有人被锁在门外**——`clients.json` 坏掉时
 * `parsed === false`，调用方据此保留上一份可用集合（见 index.ts 的热重载 effect）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clientsFile, fingerprint, loadClients, publicKeyFile, seedFromComposition,
} from '../src/core/clients-store.ts'
import { SignatureVerifier, NonceCache } from '../src/core/auth.ts'

const PEM = '-----BEGIN PUBLIC KEY-----\nMIIBfake\n-----END PUBLIC KEY-----'

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-clients-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 写一份可用目录：clients.json + 各自 .pem。 */
function writeClients(dir: string, entries: unknown[], pems: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(clientsFile(dir), JSON.stringify({ clients: entries }), 'utf8')
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const id = (entry as { clientId?: unknown }).clientId
    // 只为安全 id 写公钥文件：非法 id（如 ../escape）绝不能越出 dir
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue
    writeFileSync(publicKeyFile(dir, id), pems[id] ?? PEM, 'utf8')
  }
}

test('missing clients.json is not a fatal parse — parsed=false so the caller keeps its set', () => {
  withDir((dir) => {
    const r = loadClients(dir)
    assert.equal(r.parsed, false)
    assert.deepEqual(r.clients, [])
    assert.match(r.problems.join(' '), /clients\.json/)
  })
})

test('valid directory loads clients with scope', () => {
  withDir((dir) => {
    writeClients(dir, [
      { clientId: 'biz-system-a', scope: ['stream', 'callback'], enabled: true },
      { clientId: 'admin-ops', scope: ['admin'] },
    ])
    const r = loadClients(dir)
    assert.equal(r.parsed, true)
    assert.deepEqual(r.problems, [])
    assert.deepEqual(r.clients.map((c) => c.clientId).sort(), ['admin-ops', 'biz-system-a'])
    assert.deepEqual(r.clients.find((c) => c.clientId === 'admin-ops')?.scope, ['admin'])
    assert.equal(r.clients[0]?.publicKey, PEM)
  })
})

test('a bare array is accepted as well as { clients: [...] }', () => {
  withDir((dir) => {
    writeClients(dir, [{ clientId: 'a', scope: ['stream'] }])
    writeFileSync(clientsFile(dir), JSON.stringify([{ clientId: 'a', scope: ['stream'] }]), 'utf8')
    const r = loadClients(dir)
    assert.equal(r.parsed, true)
    assert.deepEqual(r.clients.map((c) => c.clientId), ['a'])
  })
})

test('enabled:false retires a client without deleting anything (the revocation path)', () => {
  withDir((dir) => {
    writeClients(dir, [{ clientId: 'old', scope: ['stream'], enabled: false }])
    const r = loadClients(dir)
    assert.equal(r.parsed, true)
    assert.deepEqual(r.clients, [])
    assert.match(r.problems.join(' '), /enabled:false/)
  })
})

test('a missing .pem skips that client but keeps the others', () => {
  withDir((dir) => {
    writeClients(dir, [
      { clientId: 'good', scope: ['stream'] },
      { clientId: 'broken', scope: ['stream'] },
    ])
    rmSync(publicKeyFile(dir, 'broken'))
    const r = loadClients(dir)
    assert.equal(r.parsed, true)
    assert.deepEqual(r.clients.map((c) => c.clientId), ['good'])
    assert.match(r.problems.join(' '), /broken\.pem/)
  })
})

test('malformed JSON is a parse failure, never an empty authoritative set', () => {
  withDir((dir) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(clientsFile(dir), '{ "clients": [ ', 'utf8')
    const r = loadClients(dir)
    assert.equal(r.parsed, false)
    assert.match(r.problems.join(' '), /不是合法 JSON/)
  })
})

test('unsafe and duplicate clientIds are rejected', () => {
  withDir((dir) => {
    writeClients(dir, [
      { clientId: '../escape', scope: ['stream'] },
      { clientId: 'has space', scope: ['stream'] },
      { clientId: 'dup', scope: ['stream'] },
      { clientId: 'dup', scope: ['admin'] },
      { clientId: 'ok', scope: ['stream'] },
    ])
    const r = loadClients(dir)
    // 第一个 dup 合法（取其 stream scope），第二个因重复被拒
    assert.deepEqual(r.clients.map((c) => c.clientId), ['dup', 'ok'])
    assert.deepEqual(r.clients.find((c) => c.clientId === 'dup')?.scope, ['stream'])
    assert.match(r.problems.join(' '), /非法/)
    assert.match(r.problems.join(' '), /重复/)
  })
})

test('unknown or empty scope is rejected', () => {
  withDir((dir) => {
    writeClients(dir, [
      { clientId: 'a', scope: ['superuser'] },
      { clientId: 'b', scope: [] },
      { clientId: 'c', scope: ['stream'] },
    ])
    const r = loadClients(dir)
    assert.deepEqual(r.clients.map((c) => c.clientId), ['c'])
    assert.match(r.problems.join(' '), /scope 非法/)
  })
})

test('fingerprint moves when the directory content changes', () => {
  withDir((dir) => {
    mkdirSync(dir, { recursive: true })
    const before = fingerprint(dir)
    writeClients(dir, [{ clientId: 'a', scope: ['stream'] }])
    const after = fingerprint(dir)
    assert.notEqual(before, after)
    assert.equal(fingerprint(dir), after, 'stable when nothing changes')
  })
})

test('seedFromComposition migrates once and never overwrites', () => {
  withDir((dir) => {
    const legacy = [{ clientId: 'biz-system-a', publicKey: PEM, scope: ['stream' as const] }]
    assert.equal(seedFromComposition(dir, legacy), true)
    assert.equal(readFileSync(publicKeyFile(dir, 'biz-system-a'), 'utf8').trim(), PEM)
    assert.deepEqual(loadClients(dir).clients.map((c) => c.clientId), ['biz-system-a'])
    // 第二次：已有 clients.json，不得覆盖（运维可能已改过）
    assert.equal(seedFromComposition(dir, legacy), false)
    writeFileSync(clientsFile(dir), JSON.stringify({ clients: [] }), 'utf8')
    assert.deepEqual(loadClients(dir).clients, [])
  })
})

test('verifier.reload swaps the accepted client set without a restart', () => {
  const verifier = new SignatureVerifier([], 300)
  assert.equal(verifier.describeClients().length, 0)
  verifier.reload([{ clientId: 'a', publicKey: PEM, scope: ['stream'] }])
  assert.deepEqual(verifier.describeClients().map((c) => c.clientId), ['a'])
  verifier.reload([])
  assert.deepEqual(verifier.describeClients(), [])
})

test('NonceCache stays independent of the client set', () => {
  const cache = new NonceCache(10, 300)
  assert.equal(cache.has('n'), false)
  cache.store('n')
  assert.equal(cache.has('n'), true)
})
