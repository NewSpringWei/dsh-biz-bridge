/**
 * 出站产物发现测试（§6.4.5）：工作区快照与任务前后差异对比。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffWorkspace, relativeOf, snapshotWorkspace, SNAPSHOT_MAX_ENTRIES } from '../src/core/artifacts.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'bizbridge-art-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const LIMITS = { enabled: true, maxFiles: 10, maxFileBytes: 1024 }

test('artifacts: 快照记录相对路径与指纹，跳过排除目录', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'out/nested'), { recursive: true })
    await mkdir(join(dir, 'attachments/inbound/t'), { recursive: true })
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'out/report.md'), 'hello')
    await writeFile(join(dir, 'out/nested/data.csv'), 'a,b')
    await writeFile(join(dir, 'attachments/inbound/t/in.png'), 'inbound')
    await writeFile(join(dir, 'node_modules/dep.js'), 'dep')
    const snapshot = await snapshotWorkspace(dir, ['attachments', 'node_modules'])
    assert.deepEqual([...snapshot.keys()].sort(), ['out/nested/data.csv', 'out/report.md'])
    assert.equal(snapshot.get('out/report.md')?.bytes, 5)
  })
})

test('artifacts: diff 只报新增或内容变化的文件，并按路径排序', async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, 'out'), { recursive: true })
    await writeFile(join(dir, 'out/keep.txt'), 'same')
    const before = await snapshotWorkspace(dir, [])
    await writeFile(join(dir, 'out/keep.txt'), 'changed!')
    await writeFile(join(dir, 'out/new.txt'), 'new')
    await writeFile(join(dir, 'out/zeta.txt'), 'z')
    const after = await snapshotWorkspace(dir, [])
    const diff = diffWorkspace(before, after, LIMITS)
    assert.deepEqual(diff.candidates.map(candidate => candidate.relPath), ['out/keep.txt', 'out/new.txt', 'out/zeta.txt'])
    assert.equal(diff.skipped, 0)
    assert.equal(diff.candidates[1]?.bytes, 3)
  })
})

test('artifacts: 无变化时为空；关闭开关时恒为空', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'a.txt'), 'a')
    const snapshot = await snapshotWorkspace(dir, [])
    const again = await snapshotWorkspace(dir, [])
    assert.deepEqual(diffWorkspace(snapshot, again, LIMITS).candidates, [])
    assert.deepEqual(diffWorkspace(new Map(), again, { ...LIMITS, enabled: false }).candidates, [])
  })
})

test('artifacts: 个数与体积上限——被跳过的计入 skipped', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'small.txt'), 'x')
    await writeFile(join(dir, 'big.bin'), 'y'.repeat(2048))
    await writeFile(join(dir, 'another.txt'), 'z')
    const snapshot = await snapshotWorkspace(dir, [])
    const bySize = diffWorkspace(new Map(), snapshot, { ...LIMITS, maxFiles: 10, maxFileBytes: 1024 })
    assert.deepEqual(bySize.candidates.map(candidate => candidate.relPath), ['another.txt', 'small.txt'])
    assert.equal(bySize.skipped, 1)
    const byCount = diffWorkspace(new Map(), snapshot, { ...LIMITS, maxFiles: 1, maxFileBytes: 1024 })
    assert.equal(byCount.candidates.length, 1)
    assert.equal(byCount.skipped, 2)
  })
})

test('artifacts: 相对路径与遍历上限常量', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'f.txt'), 'f')
    assert.equal(relativeOf(dir, join(dir, 'f.txt')), 'f.txt')
  })
  assert.ok(SNAPSHOT_MAX_ENTRIES >= 1000)
})

test('artifacts: 符号链接不进入快照（产物必须是工作区内真实文件）', async () => {
  await withTempDir(async (dir) => {
    const outside = await mkdtemp(join(tmpdir(), 'bizbridge-out-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await mkdir(join(dir, 'out'), { recursive: true })
      await symlink(join(outside, 'secret.txt'), join(dir, 'out/link.txt'))
      const snapshot = await snapshotWorkspace(dir, [])
      assert.deepEqual([...snapshot.keys()], [])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
