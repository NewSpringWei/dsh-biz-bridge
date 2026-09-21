/**
 * 第一方静态页测试（无浏览器环境的冒烟）：
 *  - 内联脚本与 common.js 的语法编译、`$(id)` 引用、`Bridge.*` 导出；
 *  - 页面签名口径与插件验签一致（GET + 空请求体 与 POST + JSON 体两种附件下载）；
 *  - 附件清单渲染（方向、体积、HTML 转义、事件委托、空态）。
 *
 * 用 vm 加载真实的 public/static/common.js，只 stub 掉 window/document。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { buildSignString, verifySignature } from '../src/core/auth.ts'

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'static')
const read = (name: string): string => readFileSync(join(STATIC_DIR, name), 'utf8')
const PAGES = ['index.html', 'admin.html', 'client.html', 'utils.html']
const BASE = 'http://127.0.0.1:42731'
const COMMON = read('common.js')

/** 页面侧 Bridge 面（沙箱里由 common.js 挂载）。 */
interface BridgeLike {
  makeHeaders(method: string, path: string, body: unknown): Promise<Record<string, string>>
  renderAttachments(container: unknown, list: unknown[], emptyText?: string): void
}

function pemWrap(base64: string, label: string): string {
  const lines = base64.match(/.{1,64}/g) ?? [base64]
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`
}

/** 在 vm 沙箱里加载 common.js，返回页面侧 Bridge 面与配套公钥。 */
async function loadPageBridge(): Promise<{ bridge: BridgeLike; publicPem: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  )
  const publicPem = pemWrap(Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64'), 'PUBLIC KEY')
  const privatePem = pemWrap(Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64'), 'PRIVATE KEY')

  const fields: Record<string, string> = { authClientId: 'biz-system-a', authPrivateKey: privatePem, authBaseUrl: '' }
  const sandbox = {
    window: { location: { origin: BASE } } as Record<string, unknown>,
    document: {
      readyState: 'complete',
      body: { getAttribute: (): string => 'client' },
      getElementById: (id: string): { value: string } | null => (id in fields ? { value: fields[id] as string } : null),
      querySelectorAll: (): unknown[] => [],
      addEventListener: (): void => undefined,
    },
    crypto,
    TextEncoder,
    URL,
    btoa,
    atob,
    setTimeout,
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(COMMON, sandbox, { filename: 'common.js' })
  return { bridge: sandbox.window.Bridge as BridgeLike, publicPem }
}

// ---------- 结构与语法 ----------

test('静态页：内联脚本语法、$(id) 引用与 Bridge.* 导出全部一致', () => {
  for (const page of PAGES) {
    const html = read(page)
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1] as string))
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1] as string)
    for (const [index, code] of inline.entries()) {
      assert.doesNotThrow(() => new vm.Script(code, { filename: `${page}#script${index + 1}` }), `${page} 内联脚本语法`)
    }
    const code = inline.join('\n')
    const used = new Set([...code.matchAll(/\$\('([A-Za-z][A-Za-z0-9_]*)'\)/g)].map(match => match[1] as string))
    const missing = [...used].filter(id => !ids.has(id))
    assert.deepEqual(missing, [], `${page} 引用的 id 必须都存在`)
    const exported = new Set([...COMMON.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map(match => match[1] as string))
    const called = [...new Set([...code.matchAll(/\bB\.([a-zA-Z]+)\s*\(/g)].map(match => match[1] as string))]
    assert.deepEqual(called.filter(name => !exported.has(name)), [], `${page} 调用的 Bridge 成员必须都已导出`)
  }
})

test('静态页：common.js 语法与 Bridge 导出面', () => {
  assert.doesNotThrow(() => new vm.Script(COMMON, { filename: 'common.js' }))
  for (const name of ['makeHeaders', 'request', 'sseOpen', 'renderAttachments', 'downloadAttachment', 'fetchAttachment', 'formatBytes']) {
    assert.match(COMMON, new RegExp(`\\b${name}: ${name},`), `common.js 必须导出 ${name}`)
  }
})

test('client.html：附件双向交互元素与调用齐备', () => {
  const html = read('client.html')
  for (const id of ['sAttList', 'cAttList', 'sseAttIn', 'sseAttOut', 'cbAttIn', 'cbAttOut', 'mineAtt', 'msgMineAtt',
    'btnSAddAtt', 'btnSSampleAtt', 'btnCAddAtt', 'btnCSampleAtt']) {
    assert.ok(html.includes(`id="${id}"`), `client.html 必须包含 #${id}`)
  }
  // 入站：提交体带 attachments（stream 与 callback 各一处）
  assert.equal([...html.matchAll(/if \(attachments\.length\) body\.attachments = attachments/g)].length, 2)
  // 出站：四个回执位置都要渲染清单
  for (const target of ['sseAttIn', 'sseAttOut', 'cbAttIn', 'cbAttOut', 'mineAtt']) {
    assert.ok(html.includes(`B.renderAttachments($('${target}')`), `必须在 #${target} 渲染附件清单`)
  }
})

// ---------- 签名口径 ----------

test('静态页：GET 附件下载的签名与插件验签口径一致', async () => {
  const { bridge, publicPem } = await loadPageBridge()
  const path = '/bizbridge/api/v1/attachments/3f1c9b2e-0000-4000-8000-000000000000'
  const headers = await bridge.makeHeaders('GET', path, undefined)
  const signString = buildSignString('GET', path, headers['X-Timestamp'] as string, headers['X-Nonce'] as string, Buffer.alloc(0))
  assert.equal(verifySignature(publicPem, signString, headers['X-Signature'] as string), true)

  // 负例：附件 ID 改一位即验签失败（签名绑定路径）
  const other = buildSignString(
    'GET', '/bizbridge/api/v1/attachments/3f1c9b2e-0000-4000-8000-000000000001',
    headers['X-Timestamp'] as string, headers['X-Nonce'] as string, Buffer.alloc(0),
  )
  assert.equal(verifySignature(publicPem, other, headers['X-Signature'] as string), false)
})

test('静态页：POST 附件下载签名与插件验签口径一致', async () => {
  const { bridge, publicPem } = await loadPageBridge()
  const path = '/bizbridge/api/v1/attachments/download'
  const body = { attachment_id: '3f1c9b2e-0000-4000-8000-000000000000' }
  const headers = await bridge.makeHeaders('POST', path, body)
  const signString = buildSignString('POST', path, headers['X-Timestamp'] as string, headers['X-Nonce'] as string, Buffer.from(JSON.stringify(body)))
  assert.equal(verifySignature(publicPem, signString, headers['X-Signature'] as string), true)

  // 负例：attachment_id 改一位即验签失败
  const otherBody = { attachment_id: '3f1c9b2e-0000-4000-8000-000000000001' }
  const other = buildSignString('POST', path, headers['X-Timestamp'] as string, headers['X-Nonce'] as string, Buffer.from(JSON.stringify(otherBody)))
  assert.equal(verifySignature(publicPem, other, headers['X-Signature'] as string), false)
})

test('静态页：POST + JSON 体（含 attachments）签名口径未回归', async () => {
  const { bridge, publicPem } = await loadPageBridge()
  const body = {
    biz_id: 'REQ-1', session_id: 'sess-1', prompt: 'hi',
    attachments: [{ type: 'file', uri: 'https://biz.example.com/a.txt' }],
  }
  const path = '/bizbridge/api/v1/stream'
  const headers = await bridge.makeHeaders('POST', path, body)
  const signString = buildSignString('POST', path, headers['X-Timestamp'] as string, headers['X-Nonce'] as string, Buffer.from(JSON.stringify(body)))
  assert.equal(verifySignature(publicPem, signString, headers['X-Signature'] as string), true)
})

// ---------- 清单渲染 ----------

test('静态页：附件清单渲染（方向、体积、转义、事件委托、空态）', async () => {
  const { bridge } = await loadPageBridge()
  let rendered = ''
  const container = {
    get innerHTML(): string { return rendered },
    set innerHTML(value: string) { rendered = value },
    onclick: null as null | ((ev: unknown) => void),
  }
  bridge.renderAttachments(container, [
    { attachment_id: 'a-1', direction: 'inbound', name: 'chart.png', mime: 'image/png', bytes: 2048 },
    { attachment_id: 'a-2', direction: 'outbound', name: '报告 <v1>.md', mime: 'text/markdown', bytes: 1536 },
  ], '（无附件）')
  assert.match(rendered, /data-att-id="a-1"/)
  assert.match(rendered, />下载<\/button>/)
  assert.match(rendered, /入站/)
  assert.match(rendered, /出站/)
  assert.match(rendered, /2\.0 KiB/)
  assert.match(rendered, /1\.5 KiB/)
  assert.match(rendered, /&lt;v1&gt;/) // 文件名按 HTML 转义
  assert.equal(typeof container.onclick, 'function')

  bridge.renderAttachments(container, [], '（无附件）')
  assert.match(rendered, /（无附件）/)
  assert.equal(container.onclick, null)
})

test('静态页：formatBytes 边界', async () => {
  const { bridge } = await loadPageBridge()
  const formatBytes = (bridge as unknown as { formatBytes(n: number): string }).formatBytes
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(1024 * 1024), '1.00 MiB')
})
