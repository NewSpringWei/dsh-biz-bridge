/**
 * 签名验签中间件测试（§6.2 / 步骤 3）：正常/过期时间戳/重放 nonce/错签/
 * 未知 client/越权 scope、验签失败不消耗 nonce、query 不参与签名串。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  sign as rsaSign,
} from 'node:crypto'
import { buildSignString, NonceCache, NoopNonceSeen, SignatureVerifier, verifySignature } from '../src/core/auth.ts'
import { UnauthorizedError } from '../src/shared/errors.ts'

/** 生成 RSA-2048 密钥对。 */
function keyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

function sign(privateKeyPem: string, method: string, path: string, body: Buffer, timestamp: string, nonce: string): string {
  const signString = buildSignString(method, path, timestamp, nonce, body)
  return rsaSign('sha256', Buffer.from(signString), privateKeyPem).toString('base64')
}

function makeHeaders(partial: Record<string, string>): Record<string, string> {
  return {
    'x-client-id': 'biz-a',
    'x-timestamp': Math.floor(Date.now() / 1000).toString(),
    'x-nonce': 'nonce-1',
    'x-signature': '',
    ...partial,
  }
}

const NOW = Math.floor(Date.now() / 1000)

function verifierWith(clients: Array<{ clientId: string; publicKey: string; scope: Array<'stream' | 'callback' | 'admin'> }>): SignatureVerifier {
  return new SignatureVerifier(clients, 300)
}

test('valid signature passes and consumes nonce', () => {
  const { publicKey, privateKey } = keyPair()
  const verifier = verifierWith([{ clientId: 'biz-a', publicKey, scope: ['stream', 'callback'] }])
  const nonceSeen = new NonceCache(100, 300)
  const body = Buffer.from(JSON.stringify({ biz_id: 'REQ-1' }))
  const ts = String(NOW)
  const nonce = 'uuid-nonce'
  const headers = makeHeaders({ 'x-signature': sign(privateKey, 'POST', '/bizbridge/api/v1/stream', body, ts, nonce), 'x-timestamp': ts, 'x-nonce': nonce })
  const caller = verifier.verify(headers, 'POST', '/bizbridge/api/v1/stream', body, nonceSeen)
  assert.equal(caller.clientId, 'biz-a')
  assert.deepEqual(caller.scope, ['stream', 'callback'])
  assert.equal(nonceSeen.has(`biz-a:${nonce}`), true)
})

test('timestamp outside window rejected (401 semantics)', () => {
  const { publicKey, privateKey } = keyPair()
  const verifier = verifierWith([{ clientId: 'biz-a', publicKey, scope: ['stream'] }])
  const body = Buffer.from('{}')
  const ts = String(NOW + 301)
  const headers = makeHeaders({ 'x-signature': sign(privateKey, 'POST', '/p', body, ts, 'n'), 'x-timestamp': ts, 'x-nonce': 'n' })
  assert.throws(() => verifier.verify(headers, 'POST', '/p', body, new NoopNonceSeen()), UnauthorizedError)
})

test('nonce replay rejected and not double-consumed', () => {
  const { publicKey, privateKey } = keyPair()
  const verifier = verifierWith([{ clientId: 'biz-a', publicKey, scope: ['stream'] }])
  const nonceSeen = new NonceCache(100, 300)
  const body = Buffer.from('{"a":1}')
  const ts = String(NOW)
  const nonce = 'repeat-nonce'
  const headers = makeHeaders({ 'x-signature': sign(privateKey, 'POST', '/p', body, ts, nonce), 'x-timestamp': ts, 'x-nonce': nonce })
  verifier.verify(headers, 'POST', '/p', body, nonceSeen)
  assert.throws(() => verifier.verify(headers, 'POST', '/p', body, nonceSeen), UnauthorizedError)
})

test('wrong signature rejected and does NOT consume nonce', () => {
  const { publicKey, privateKey } = keyPair()
  const verifier = verifierWith([{ clientId: 'biz-a', publicKey, scope: ['stream'] }])
  const nonceSeen = new NonceCache(100, 300)
  const body = Buffer.from('{"a":1}')
  const ts = String(NOW)
  const nonce = 'retry-nonce'
  // 第一次错签
  const badHeaders = makeHeaders({ 'x-signature': 'AAAA', 'x-timestamp': ts, 'x-nonce': nonce })
  assert.throws(() => verifier.verify(badHeaders, 'POST', '/p', body, nonceSeen), UnauthorizedError)
  assert.equal(nonceSeen.has(`biz-a:${nonce}`), false)
  // 同 nonce 重试正确签名可过（验签失败不消耗 nonce）
  const goodHeaders = makeHeaders({ 'x-signature': sign(privateKey, 'POST', '/p', body, ts, nonce), 'x-timestamp': ts, 'x-nonce': nonce })
  const caller = verifier.verify(goodHeaders, 'POST', '/p', body, nonceSeen)
  assert.equal(caller.clientId, 'biz-a')
  // 再重放被拒
  assert.throws(() => verifier.verify(goodHeaders, 'POST', '/p', body, nonceSeen), UnauthorizedError)
})

test('unknown client rejected', () => {
  const { publicKey } = keyPair()
  const verifier = verifierWith([{ clientId: 'other', publicKey, scope: ['stream'] }])
  const body = Buffer.from('{}')
  const headers = makeHeaders({ 'x-timestamp': String(NOW), 'x-nonce': 'x' })
  assert.throws(() => verifier.verify(headers, 'POST', '/p', body, new NoopNonceSeen()), UnauthorizedError)
})

test('missing header rejected', () => {
  const { publicKey, privateKey } = keyPair()
  const verifier = verifierWith([{ clientId: 'biz-a', publicKey, scope: ['stream'] }])
  const body = Buffer.from('{}')
  const headers = makeHeaders({ 'x-signature': sign(privateKey, 'POST', '/p', body, String(NOW), 'n'), 'x-timestamp': String(NOW) })
  delete headers['x-nonce']
  assert.throws(() => verifier.verify(headers, 'POST', '/p', body, new NoopNonceSeen()), UnauthorizedError)
})

test('scope helpers reflect caller scope lists', () => {
  const { publicKey } = keyPair()
  const verifier = verifierWith([
    { clientId: 'biz-a', publicKey, scope: ['callback'] },
    { clientId: 'admin', publicKey, scope: ['admin'] },
  ])
  const biz = { clientId: 'biz-a', scope: ['callback'] as const }
  const admin = { clientId: 'admin', scope: ['admin'] as const }
  assert.equal(verifier.hasScope(biz, 'callback'), true)
  assert.equal(verifier.hasScope(biz, 'admin'), false)
  assert.equal(verifier.hasScope(admin, 'admin'), true)
  assert.equal(verifier.hasScope(admin, 'stream'), false)
})

test('signString: query is excluded; sha256 hex lowercase and method matters', () => {
  const body = Buffer.from('{"q":1}')
  const sha = createHash('sha256').update(body).digest('hex')
  assert.equal(buildSignString('POST', '/bizbridge/api/v1/stream', '1693800000', 'n', body),
    `POST/bizbridge/api/v1/stream1693800000n${sha}`)
  const withQuery = buildSignString('POST', '/bizbridge/api/v1/stream?x=1', '1693800000', 'n', body)
  assert.notEqual(withQuery, buildSignString('GET', '/bizbridge/api/v1/stream', '1693800000', 'n', body))
})

test('verifySignature rejects garbage public keys', () => {
  assert.equal(verifySignature('not-a-pem', 'abc', 'def'), false)
})

test('NonceCache prunes old entries beyond window', () => {
  const cache = new NonceCache(10, 5)
  cache.store('a:1', 1000)
  assert.equal(cache.has('a:1'), true)
  cache.prune(1006)
  assert.equal(cache.has('a:1'), false)
})

test('NonceCache evicts oldest beyond capacity', () => {
  const cache = new NonceCache(2, 1000)
  cache.store('a:1', 1)
  cache.store('a:2', 2)
  cache.store('a:3', 3)
  assert.equal(cache.has('a:1'), false)
  assert.equal(cache.has('a:2'), true)
  assert.equal(cache.has('a:3'), true)
  assert.equal(cache.size(), 2)
})
