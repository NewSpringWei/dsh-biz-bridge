/**
 * 附件转接核心测试（§6.4.4）：声明校验、命名净化、路径越界防护、
 * URI 拉取落盘、内容块组装。全部走注入端口，不依赖 DSH 运行时。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachmentNameFrom, buildUserContent, imageMediaTypeFromName, isImageMediaType, mimeFromName,
  normalizeMime, parseAttachmentRequests, prepareInboundAttachments, resolveWorkspacePath,
  safeAttachmentFileName, toAttachmentEntry,
  type AttachmentFetcher, type AttachmentLimits,
} from '../src/core/attachments.ts'
import { InvalidRequestError } from '../src/shared/errors.ts'
import { normalizeConfig } from '../src/config/config.ts'
import type { TaskAttachmentRow } from '../src/shared/types.ts'

const LIMITS: AttachmentLimits = {
  maxItems: 3,
  maxFileBytes: 1024,
  maxTotalBytes: 2048,
  fetchTimeout: 5,
  allowedHosts: [],
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** 按 URI 返回预置字节的假拉取器。 */
function fetcherOf(files: Record<string, { data: Uint8Array; mime: string | null }>): AttachmentFetcher {
  return async (uri) => {
    const hit = files[uri]
    if (hit === undefined) throw new InvalidRequestError(`fake fetch miss: ${uri}`)
    return hit
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'bizbridge-att-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------- 声明校验（parseAttachmentRequests） ----------

test('attachments: 缺省为空数组；非数组/非法类型/非法 URI 均拒绝', () => {
  assert.deepEqual(parseAttachmentRequests(undefined, LIMITS), [])
  assert.deepEqual(parseAttachmentRequests(null, LIMITS), [])
  assert.throws(() => parseAttachmentRequests('x', LIMITS), InvalidRequestError)
  assert.throws(() => parseAttachmentRequests([null], LIMITS), InvalidRequestError)
  assert.throws(() => parseAttachmentRequests([{ type: 'video', uri: 'https://h/a' }], LIMITS), InvalidRequestError)
  assert.throws(() => parseAttachmentRequests([{ type: 'file' }], LIMITS), InvalidRequestError)
  assert.throws(() => parseAttachmentRequests([{ type: 'file', uri: 'not-a-url' }], LIMITS), InvalidRequestError)
  assert.throws(() => parseAttachmentRequests([{ type: 'file', uri: 'file:///etc/passwd' }], LIMITS), InvalidRequestError)
  assert.throws(() => parseAttachmentRequests([{ type: 'file', uri: 'https://h/a', name: 1 }], LIMITS), InvalidRequestError)
})

test('attachments: 条数上限与 host 白名单', () => {
  const many = [
    { type: 'file', uri: 'https://h/a' },
    { type: 'file', uri: 'https://h/b' },
    { type: 'file', uri: 'https://h/c' },
    { type: 'file', uri: 'https://h/d' },
  ]
  assert.throws(() => parseAttachmentRequests(many, LIMITS), InvalidRequestError)
  const strict = { ...LIMITS, allowedHosts: ['biz.example.com'] }
  assert.throws(() => parseAttachmentRequests([{ type: 'file', uri: 'https://other/a' }], strict), InvalidRequestError)
  assert.deepEqual(
    parseAttachmentRequests([{ type: 'file', uri: 'https://biz.example.com:8443/a' }], { ...LIMITS, allowedHosts: ['biz.example.com:8443'] }),
    [{ type: 'file', uri: 'https://biz.example.com:8443/a' }],
  )
})

test('attachments: 声明字段归一化（name/mime 空串丢弃、顺序保持）', () => {
  const parsed = parseAttachmentRequests([
    { type: 'image', uri: 'https://h/1.png', name: '', mime: 'image/png' },
    { type: 'file', uri: 'https://h/2.pdf', name: 'spec.pdf' },
  ], LIMITS)
  assert.deepEqual(parsed, [
    { type: 'image', uri: 'https://h/1.png', mime: 'image/png' },
    { type: 'file', uri: 'https://h/2.pdf', name: 'spec.pdf' },
  ])
})

// ---------- 命名与 MIME（纯函数） ----------

test('attachments: 文件名净化（路径剥离、非法字符、设备名、空值兜底）', () => {
  assert.equal(safeAttachmentFileName('a/b/c.png'), 'c.png')
  assert.equal(safeAttachmentFileName('E:\\tmp\\report.pdf'), 'report.pdf')
  assert.equal(safeAttachmentFileName('a<b>c:d?.txt'), 'a_b_c_d_.txt')
  assert.equal(safeAttachmentFileName('CON'), '_CON')
  assert.equal(safeAttachmentFileName('nul.txt'), 'nul.txt')
  assert.equal(safeAttachmentFileName('   '), 'attachment')
  assert.equal(safeAttachmentFileName('..'), 'attachment')
  assert.equal(safeAttachmentFileName(`${'x'.repeat(300)}.txt`).length, 128)
})

test('attachments: 展示名优先声明，否则由 URI 末段推断（含解码）', () => {
  assert.equal(attachmentNameFrom('https://h/dir/a.png', 'logo.png'), 'logo.png')
  assert.equal(attachmentNameFrom('https://h/dir/a.png'), 'a.png')
  assert.equal(attachmentNameFrom('https://h/dir/%E4%B8%AD%E6%96%87.png'), '中文.png')
  assert.equal(attachmentNameFrom('https://h/dir/'), 'attachment')
})

test('attachments: 媒体类型归一化与推断', () => {
  assert.equal(normalizeMime('image/PNG; charset=binary'), 'image/png')
  assert.equal(normalizeMime(undefined), null)
  assert.equal(imageMediaTypeFromName('a.JPEG'), 'image/jpeg')
  assert.equal(imageMediaTypeFromName('a.bmp'), null)
  assert.equal(isImageMediaType('image/webp'), true)
  assert.equal(isImageMediaType('application/pdf'), false)
  assert.equal(mimeFromName('report.pdf'), 'application/pdf')
  assert.equal(mimeFromName('data.bin'), 'application/octet-stream')
  assert.equal(mimeFromName('noext'), 'application/octet-stream')
})

// ---------- 路径越界防护 ----------

test('attachments: 相对路径解析拒绝越界与绝对路径逃逸', () => {
  const workspace = join(tmpdir(), 'bizbridge-ws')
  assert.equal(resolveWorkspacePath(workspace, 'attachments/inbound/t/a.png'), join(workspace, 'attachments/inbound/t/a.png'))
  assert.throws(() => resolveWorkspacePath(workspace, '../outside.txt'), InvalidRequestError)
  assert.throws(() => resolveWorkspacePath(workspace, 'a/../../outside.txt'), InvalidRequestError)
})

// ---------- 入站拉取落盘（prepareInboundAttachments） ----------

test('attachments: 配置对象可直接作为拉取上限（字段名对齐，防 NaN 超时）', async () => {
  await withTempDir(async (dir) => {
    // normalizeConfig 的输出必须能直接当 AttachmentLimits 用：字段名一旦漂移
    // （曾出现配置 `fetchTimeout` vs 接口 `fetchTimeoutSeconds`），运行时会取到 undefined，
    // 最终在 AbortSignal.timeout(NaN) 处抛错——本用例专拦这个。
    const limits = normalizeConfig(undefined).attachments
    let seen: { timeoutSeconds: number; maxBytes: number } | undefined
    const prepared = await prepareInboundAttachments({
      requests: [{ type: 'file', uri: 'https://biz/a.pdf' }],
      limits,
      workspaceDir: dir,
      taskId: 'task-cfg',
      fetch: async (_uri, options) => {
        seen = options
        return { data: bytesOf('pdf'), mime: 'application/pdf' }
      },
    })
    assert.ok(Number.isSafeInteger(seen?.timeoutSeconds) && (seen?.timeoutSeconds ?? 0) > 0, `timeoutSeconds=${seen?.timeoutSeconds}`)
    assert.equal(seen?.timeoutSeconds, limits.fetchTimeout)
    assert.equal(seen?.maxBytes, limits.maxFileBytes)
    assert.equal(prepared.length, 1)
  })
})

test('attachments: 入站拉取落盘（顺序、相对路径、字节一致）', async () => {
  await withTempDir(async (dir) => {
    const png = bytesOf('PNG-BYTES')
    const pdf = bytesOf('PDF-BYTES')
    const fetch = fetcherOf({
      'https://biz/a.png': { data: png, mime: 'image/png' },
      'https://biz/b.pdf': { data: pdf, mime: 'application/pdf' },
    })
    const prepared = await prepareInboundAttachments({
      requests: [
        { type: 'image', uri: 'https://biz/a.png' },
        { type: 'file', uri: 'https://biz/b.pdf', name: 'spec.pdf' },
      ],
      limits: LIMITS,
      workspaceDir: dir,
      taskId: 'task-1',
      fetch,
    })
    assert.deepEqual(prepared.map(item => item.name), ['a.png', 'spec.pdf'])
    assert.deepEqual(prepared.map(item => item.relPath), ['attachments/inbound/task-1/a.png', 'attachments/inbound/task-1/spec.pdf'])
    assert.deepEqual(prepared.map(item => item.mime), ['image/png', 'application/pdf'])
    assert.deepEqual(prepared.map(item => item.bytes), [png.byteLength, pdf.byteLength])
    assert.deepEqual(new Uint8Array(await readFile(join(dir, prepared[0]!.relPath))), png)
    assert.deepEqual(new Uint8Array(await readFile(join(dir, prepared[1]!.relPath))), pdf)
  })
})

test('attachments: 入站同名附件自动去重（不覆盖）', async () => {
  await withTempDir(async (dir) => {
    const fetch = fetcherOf({
      'https://biz/1/report.pdf': { data: bytesOf('one'), mime: 'application/pdf' },
      'https://biz/2/report.pdf': { data: bytesOf('two'), mime: 'application/pdf' },
    })
    const prepared = await prepareInboundAttachments({
      requests: [
        { type: 'file', uri: 'https://biz/1/report.pdf' },
        { type: 'file', uri: 'https://biz/2/report.pdf' },
      ],
      limits: LIMITS,
      workspaceDir: dir,
      taskId: 'task-2',
      fetch,
    })
    assert.deepEqual(prepared.map(item => item.name), ['report.pdf', 'report-1.pdf'])
    assert.equal(new TextDecoder().decode(await readFile(join(dir, prepared[0]!.relPath))), 'one')
    assert.equal(new TextDecoder().decode(await readFile(join(dir, prepared[1]!.relPath))), 'two')
  })
})

test('attachments: 图片媒体类型无法判定 / 不受支持时拒绝', async () => {
  await withTempDir(async (dir) => {
    const fetch = fetcherOf({
      'https://biz/x.bin': { data: bytesOf('x'), mime: 'application/octet-stream' },
      'https://biz/y.bmp': { data: bytesOf('y'), mime: 'image/bmp' },
    })
    await assert.rejects(
      () => prepareInboundAttachments({
        requests: [{ type: 'image', uri: 'https://biz/x.bin' }], limits: LIMITS, workspaceDir: dir, taskId: 't', fetch,
      }),
      InvalidRequestError,
    )
    await assert.rejects(
      () => prepareInboundAttachments({
        requests: [{ type: 'image', uri: 'https://biz/y.bmp' }], limits: LIMITS, workspaceDir: dir, taskId: 't', fetch,
      }),
      InvalidRequestError,
    )
  })
})

test('attachments: 声明 mime 可修正响应头缺失（image/jpeg）', async () => {
  await withTempDir(async (dir) => {
    const fetch = fetcherOf({ 'https://biz/p': { data: bytesOf('jpeg'), mime: null } })
    const prepared = await prepareInboundAttachments({
      requests: [{ type: 'image', uri: 'https://biz/p', mime: 'image/jpeg', name: 'photo' }],
      limits: LIMITS,
      workspaceDir: dir,
      taskId: 't',
      fetch,
    })
    assert.equal(prepared[0]!.mime, 'image/jpeg')
    assert.equal(prepared[0]!.name, 'photo')
  })
})

test('attachments: 单文件与总字节上限', async () => {
  await withTempDir(async (dir) => {
    const big = { data: new Uint8Array(2048), mime: 'application/pdf' }
    const fetch = fetcherOf({ 'https://biz/big': big })
    await assert.rejects(
      () => prepareInboundAttachments({
        requests: [{ type: 'file', uri: 'https://biz/big' }], limits: LIMITS, workspaceDir: dir, taskId: 't', fetch,
      }),
      InvalidRequestError,
    )
    const half = { data: new Uint8Array(800), mime: 'application/pdf' }
    const fetch2 = fetcherOf({ 'https://biz/a': half, 'https://biz/b': half, 'https://biz/c': half })
    await assert.rejects(
      () => prepareInboundAttachments({
        requests: [
          { type: 'file', uri: 'https://biz/a' },
          { type: 'file', uri: 'https://biz/b' },
          { type: 'file', uri: 'https://biz/c' },
        ],
        limits: { ...LIMITS, maxFileBytes: 1024, maxTotalBytes: 2000 },
        workspaceDir: dir,
        taskId: 't',
        fetch: fetch2,
      }),
      InvalidRequestError,
    )
  })
})

// ---------- 内容块组装（buildUserContent） ----------

function row(overrides: Partial<TaskAttachmentRow>): TaskAttachmentRow {
  return {
    id: 'att-1',
    task_id: 'task-1',
    client_id: 'biz-a',
    direction: 'inbound',
    name: 'a.png',
    mime: 'image/png',
    bytes: 3,
    rel_path: 'attachments/inbound/task-1/a.png',
    source_uri: 'https://biz/a.png',
    content_hash: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('attachments: 内容块 = 文本在前 + 附件按账本顺序（图片走图片准入）', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'attachments/inbound/task-1'), { recursive: true })
    await writeFile(join(dir, 'attachments/inbound/task-1/a.png'), bytesOf('png'))
    await writeFile(join(dir, 'attachments/inbound/task-1/spec.pdf'), bytesOf('pdf'))
    const admitted: string[] = []
    const content = await buildUserContent({
      text: '看看这个',
      rows: [
        row({}),
        row({ id: 'att-2', name: 'spec.pdf', mime: 'application/pdf', rel_path: 'attachments/inbound/task-1/spec.pdf' }),
      ],
      workspaceDir: dir,
      admission: {
        async admitImage(input) {
          admitted.push(`image:${input.name}:${input.mediaType}`)
          return { attachmentId: 'sha256:aaa', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, name: input.name }
        },
        async admitFile(input) {
          admitted.push(`file:${input.name}`)
          return { attachmentId: 'sha256:bbb', name: input.name, bytes: input.data.byteLength }
        },
      },
      readFile: async (path) => new Uint8Array(await readFile(path)),
    })
    assert.deepEqual(admitted, ['image:a.png:image/png', 'file:spec.pdf'])
    assert.equal(content.length, 3)
    assert.deepEqual(content[0], { type: 'text', text: '看看这个' })
    assert.equal(content[1]!.type, 'image')
    assert.equal(content[2]!.type, 'file')
  })
})

test('attachments: 账本行转清单条目（不暴露路径）', () => {
  const entry = toAttachmentEntry(row({}))
  assert.deepEqual(entry, {
    attachment_id: 'att-1',
    direction: 'inbound',
    name: 'a.png',
    mime: 'image/png',
    bytes: 3,
    content_hash: null,
  })
  assert.equal('rel_path' in entry, false)
})

test('attachments: 声明为 file 时不做图片校验（内容任意）', async () => {
  await withTempDir(async (dir) => {
    const fetch = fetcherOf({ 'https://biz/data': { data: bytesOf('binary'), mime: null } })
    const prepared = await prepareInboundAttachments({
      requests: [{ type: 'file', uri: 'https://biz/data' }],
      limits: LIMITS,
      workspaceDir: dir,
      taskId: 't',
      fetch,
    })
    assert.equal(prepared[0]!.mime, null)
    assert.equal(prepared[0]!.name, 'data')
  })
})
