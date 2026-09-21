/**
 * 附件账本与转交流程测试（§4.2.4 / §6.4.4 / §6.4.5）：
 * BridgeDb 附件原语、入站落盘→账本、内容块组装、出站产物登记与清单、下载读取。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeDb, nowIso } from '../src/core/db.ts'
import { requireAttachmentOwned } from '../src/core/ops.ts'
import { ForbiddenError, NotFoundError } from '../src/shared/errors.ts'
import {
  composeUserContent, downloadInbound, listAttachmentEntries, readAttachmentBytes, recordInbound,
  registerArtifacts, snapshotBeforeRun,
} from '../src/core/attachment-flow.ts'
import type { BridgeRuntime } from '../src/shared/runtime.ts'
import type { AttachmentFetcher } from '../src/core/attachments.ts'
import type { AuthScope } from '../src/shared/types.ts'

/** 鉴权用例的三种调用者（业务属主 / 其它 client / 管理端）。 */
const OWNER = { clientId: 'biz-a', scope: ['stream'] as AuthScope[] }
const OTHER = { clientId: 'biz-b', scope: ['stream'] as AuthScope[] }
const ADMIN = { clientId: 'admin-ops', scope: ['admin'] as AuthScope[] }

function openDb(): BridgeDb {
  return new BridgeDb({ path: ':memory:', journalMode: 'WAL', busyTimeout: 2000 })
}

function insertTask(db: BridgeDb, id = 'task-1'): void {
  const now = nowIso()
  db.createTask({
    id,
    clientId: 'biz-a',
    bizId: `REQ-${id}`,
    replaySeq: 0,
    sessionId: 'biz-a:stream:s-1',
    prompt: 'p',
    type: 'stream',
    priority: 0,
    scheduledAt: now,
    now,
  })
}

/** 最小运行时：只填附件流程真正读到的字段。 */
function makeRuntime(db: BridgeDb, workspaceDir: string, overrides: {
  outbound?: Partial<{ enabled: boolean; maxFiles: number; maxFileBytes: number; exclude: string[] }>
  fetch?: AttachmentFetcher
} = {}): BridgeRuntime {
  let seq = 0
  const defaults = { enabled: true, maxFiles: 10, maxFileBytes: 4096, exclude: ['attachments'] }
  return {
    db,
    workspaceOf: () => workspaceDir,
    newAttachmentId: () => `att-${++seq}`,
    readWorkspaceFile: async (absolutePath: string) => new Uint8Array(await readFile(absolutePath)),
    attachmentFetcher: overrides.fetch ?? (async () => { throw new Error('fetcher not expected in this test') }),
    attachmentAdmission: {
      async admitImage(input) {
        return { attachmentId: 'sha256:img', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1, name: input.name }
      },
      async admitFile(input) {
        return { attachmentId: 'sha256:file', name: input.name, bytes: input.data.byteLength }
      },
    },
    fileLogger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    config: {
      attachments: { enabled: true, outbound: { ...defaults, ...overrides.outbound } },
    },
  } as unknown as BridgeRuntime
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'bizbridge-flow-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------- 账本原语 ----------

test('attachments db: 登记/读取/清单顺序/复制/级联清理', () => {
  const db = openDb()
  insertTask(db, 'task-1')
  const now = nowIso()
  const first = db.addTaskAttachment({
    id: 'a1', taskId: 'task-1', clientId: 'biz-a', direction: 'inbound',
    name: 'one.png', mime: 'image/png', bytes: 10, relPath: 'attachments/inbound/task-1/one.png',
    sourceUri: 'https://biz/one.png', now,
  })
  const second = db.addTaskAttachment({
    id: 'a2', taskId: 'task-1', clientId: 'biz-a', direction: 'outbound',
    name: 'report.md', mime: 'text/markdown', bytes: 20, relPath: 'out/report.md',
    sourceUri: null, now,
  })
  assert.equal(first.id, 'a1')
  assert.equal(second.direction, 'outbound')
  assert.equal(db.getTaskAttachment('a1')?.source_uri, 'https://biz/one.png')
  assert.equal(db.getTaskAttachment('missing'), undefined)
  assert.deepEqual(db.listTaskAttachments('task-1').map(row => row.id), ['a1', 'a2'])

  // 重播复制：只复制入站行，字节不复制
  insertTask(db, 'task-2')
  let seq = 0
  const copied = db.copyInboundAttachments('task-1', 'task-2', () => `copy-${++seq}`, now)
  assert.equal(copied, 1)
  const copiedRows = db.listTaskAttachments('task-2')
  assert.deepEqual(copiedRows.map(row => row.rel_path), ['attachments/inbound/task-1/one.png'])
  assert.equal(copiedRows[0]?.source_uri, 'https://biz/one.png')

  // 过期清理级联删除附件行
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString()
  db.createTask({
    id: 'task-old', clientId: 'biz-a', bizId: 'REQ-old', replaySeq: 0, sessionId: 's',
    prompt: 'p', type: 'stream', priority: 0, scheduledAt: old, now: old,
  })
  db.addTaskAttachment({
    id: 'old-1', taskId: 'task-old', clientId: 'biz-a', direction: 'inbound',
    name: 'x.txt', mime: 'text/plain', bytes: 1, relPath: 'attachments/inbound/task-old/x.txt',
    sourceUri: null, now: old,
  })
  db.failTask('task-old', 'expired', old)
  assert.equal(db.cleanupExpired(90), 1)
  assert.equal(db.getTaskAttachment('old-1'), undefined)
  assert.deepEqual(db.listTaskAttachments('task-1').map(row => row.id), ['a1', 'a2'])
})

// ---------- 入站：下载 → 账本 → 内容块 ----------

test('attachment flow: 入站下载落盘并登记账本（保持声明顺序）', async () => {
  await withTempDir(async (dir) => {
    const db = openDb()
    insertTask(db, 'task-1')
    const runtime = makeRuntime(db, dir, {
      fetch: async (uri) => ({
        data: new TextEncoder().encode(uri.endsWith('.png') ? 'png' : 'pdf'),
        mime: uri.endsWith('.png') ? 'image/png' : 'application/pdf',
      }),
    })
    const prepared = await downloadInbound(runtime, {
      clientId: 'biz-a',
      taskId: 'task-1',
      requests: [
        { type: 'image', uri: 'https://biz/a.png' },
        { type: 'file', uri: 'https://biz/b.pdf', name: 'spec.pdf' },
      ],
    })
    const rows = recordInbound(runtime, { clientId: 'biz-a', taskId: 'task-1', prepared })
    assert.deepEqual(rows.map(row => row.name), ['a.png', 'spec.pdf'])
    assert.deepEqual(listAttachmentEntries(runtime, 'task-1').map(entry => entry.name), ['a.png', 'spec.pdf'])
    assert.equal(new TextDecoder().decode(await readAttachmentBytes(runtime, rows[0]!)), 'png')
  })
})

test('attachment flow: 无附件请求不产生任何账本行', async () => {
  await withTempDir(async (dir) => {
    const db = openDb()
    insertTask(db, 'task-1')
    const runtime = makeRuntime(db, dir)
    const prepared = await downloadInbound(runtime, { clientId: 'biz-a', taskId: 'task-1', requests: [] })
    assert.deepEqual(prepared, [])
    assert.deepEqual(listAttachmentEntries(runtime, 'task-1'), [])
  })
})

test('attachment flow: 内容块组装读账本入站行（文本 + 图片 + 文件）', async () => {
  await withTempDir(async (dir) => {
    const db = openDb()
    insertTask(db, 'task-1')
    const runtime = makeRuntime(db, dir)
    await mkdir(join(dir, 'attachments/inbound/task-1'), { recursive: true })
    await writeFile(join(dir, 'attachments/inbound/task-1/a.png'), 'png')
    await writeFile(join(dir, 'attachments/inbound/task-1/b.bin'), 'bin')
    const now = nowIso()
    db.addTaskAttachment({
      id: 'in-1', taskId: 'task-1', clientId: 'biz-a', direction: 'inbound', name: 'a.png',
      mime: 'image/png', bytes: 3, relPath: 'attachments/inbound/task-1/a.png', sourceUri: 'https://biz/a.png', now,
    })
    db.addTaskAttachment({
      id: 'in-2', taskId: 'task-1', clientId: 'biz-a', direction: 'inbound', name: 'b.bin',
      mime: null, bytes: 3, relPath: 'attachments/inbound/task-1/b.bin', sourceUri: 'https://biz/b.bin', now,
    })
    const content = await composeUserContent(runtime, { taskId: 'task-1', clientId: 'biz-a', prompt: '看附件' })
    assert.deepEqual(content.map(block => block.type), ['text', 'image', 'file'])
    assert.deepEqual(content[1], {
      type: 'image',
      attachment: { attachmentId: 'sha256:img', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'a.png' },
    })
  })
})

test('attachment flow: 入站文件缺失时抛错（执行前失败路径）', async () => {
  await withTempDir(async (dir) => {
    const db = openDb()
    insertTask(db, 'task-1')
    const runtime = makeRuntime(db, dir)
    db.addTaskAttachment({
      id: 'in-1', taskId: 'task-1', clientId: 'biz-a', direction: 'inbound', name: 'gone.png',
      mime: 'image/png', bytes: 3, relPath: 'attachments/inbound/task-1/gone.png', sourceUri: null, now: nowIso(),
    })
    await assert.rejects(() => composeUserContent(runtime, { taskId: 'task-1', clientId: 'biz-a', prompt: 'p' }))
  })
})

// ---------- 出站：快照差异 → 登记 → 清单 ----------

test('attachment flow: 出站产物登记（MIME 推断、清单、路径不暴露）', async () => {
  await withTempDir(async (dir) => {
    const db = openDb()
    insertTask(db, 'task-1')
    const runtime = makeRuntime(db, dir)
    await mkdir(join(dir, 'out'), { recursive: true })
    const before = await snapshotBeforeRun(runtime, 'biz-a')
    await writeFile(join(dir, 'out/report.md'), '# 报告')
    await writeFile(join(dir, 'out/data.csv'), 'a,b')
    const entries = await registerArtifacts(runtime, { taskId: 'task-1', clientId: 'biz-a', before })
    assert.deepEqual(entries.map(entry => entry.name), ['data.csv', 'report.md'])
    assert.deepEqual(entries.map(entry => entry.mime), ['text/csv', 'text/markdown'])
    assert.deepEqual(entries.map(entry => entry.direction), ['outbound', 'outbound'])
    assert.equal('rel_path' in entries[0]!, false)
    assert.deepEqual(listAttachmentEntries(runtime, 'task-1').map(entry => entry.name), ['data.csv', 'report.md'])
    // 再次登记（无变化）应为空
    const again = await registerArtifacts(runtime, { taskId: 'task-1', clientId: 'biz-a', before: await snapshotBeforeRun(runtime, 'biz-a') })
    assert.deepEqual(again, [])
  })
})

test('attachment flow: 出站关闭时不登记任何产物', async () => {
  await withTempDir(async (dir) => {
    const db = openDb()
    insertTask(db, 'task-1')
    const runtime = makeRuntime(db, dir, { outbound: { enabled: false } })
    await writeFile(join(dir, 'anything.txt'), 'x')
    const entries = await registerArtifacts(runtime, { taskId: 'task-1', clientId: 'biz-a', before: new Map() })
    assert.deepEqual(entries, [])
    assert.deepEqual(listAttachmentEntries(runtime, 'task-1'), [])
  })
})

test('attachment flow: 入站落盘区不会被视为出站产物', async () => {
  await withTempDir(async (dir) => {
    const db = openDb()
    insertTask(db, 'task-1')
    const runtime = makeRuntime(db, dir)
    const before = await snapshotBeforeRun(runtime, 'biz-a')
    await mkdir(join(dir, 'attachments/inbound/task-1'), { recursive: true })
    await writeFile(join(dir, 'attachments/inbound/task-1/in.png'), 'png')
    await writeFile(join(dir, 'out.txt'), 'out')
    const entries = await registerArtifacts(runtime, { taskId: 'task-1', clientId: 'biz-a', before })
    assert.deepEqual(entries.map(entry => entry.name), ['out.txt'])
  })
})

test('attachment flow: 下载读取拒绝越界路径（账本被篡改也不逃逸工作区）', async () => {
  await withTempDir(async (dir) => {
    const db = openDb()
    insertTask(db, 'task-1')
    const runtime = makeRuntime(db, dir)
    const row = db.addTaskAttachment({
      id: 'evil', taskId: 'task-1', clientId: 'biz-a', direction: 'outbound', name: 'passwd',
      mime: null, bytes: 1, relPath: '../../etc/passwd', sourceUri: null, now: nowIso(),
    })
    await assert.rejects(() => readAttachmentBytes(runtime, row))
  })
})

test('attachment flow: 下载鉴权（不存在 404 / 跨 client 403 / admin 放行）', () => {
  const db = openDb()
  insertTask(db, 'task-1')
  db.addTaskAttachment({
    id: 'a1', taskId: 'task-1', clientId: 'biz-a', direction: 'outbound', name: 'x.md',
    mime: 'text/markdown', bytes: 1, relPath: 'out/x.md', sourceUri: null, now: nowIso(),
  })
  assert.equal(requireAttachmentOwned(db, 'a1', OWNER).id, 'a1')
  assert.throws(() => requireAttachmentOwned(db, 'a1', OTHER), ForbiddenError)
  assert.equal(requireAttachmentOwned(db, 'a1', ADMIN).id, 'a1')
  assert.throws(() => requireAttachmentOwned(db, 'missing', OWNER), NotFoundError)
})
