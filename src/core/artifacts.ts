/**
 * 出站产物发现（§6.4.5）：以"任务执行前后的工作区快照差"识别 agent 产出的文件。
 *
 * DSH 不提供"本会话产物清单"，唯一可靠且与 DSH 版本解耦的办法是对比工作区快照：
 * 任务开始前记录 `相对路径 → (字节数, mtime)`，任务结束后再记录一次，二者之差即
 * 本任务新增或改写的文件。
 *
 * 边界（写进公开文档）：
 * - 只覆盖 agent 在自身工作目录（`<runtime>/workspace/<clientId>/`）内的写入；
 *   写到工作目录之外的文件不在发现范围。
 * - 排除名为 `attachments` 的目录：那是插件的入站附件落盘区，不是产物。
 * - 单文件字节上限、单任务产物个数上限由配置约束，超限者静默跳过并计入 skipped。
 */

import { readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** 出站发现配置。 */
export interface ArtifactLimits {
  /** 是否启用出站产物发现（关闭时任务不回传任何产物）。 */
  enabled: boolean
  /** 单任务最多登记多少个产物。 */
  maxFiles: number
  /** 单个产物字节上限（超过则不登记）。 */
  maxFileBytes: number
  /** 快照时跳过的目录/文件名（按路径段精确匹配）。 */
  exclude: readonly string[]
  /** 敏感文件模式（glob，按文件名匹配；命中则排除，防数据泄露）。 */
  sensitivePatterns: readonly string[]
}

/** 快照中的单个文件。 */
export interface SnapshotEntry {
  bytes: number
  mtimeMs: number
}

/** 工作区快照：workspace 相对 POSIX 路径 → 文件指纹。 */
export type WorkspaceSnapshot = Map<string, SnapshotEntry>

/** 快照遍历上限（防止超大工作区拖慢任务收尾）。 */
export const SNAPSHOT_MAX_ENTRIES = 5000

/**
 * 递归快照工作区内的普通文件。
 * @param root 工作区绝对路径（client 会话 cwd）
 * @param exclude 跳过的路径段名称集合
 * @param sensitivePatterns 敏感文件 glob 模式（按文件名匹配排除）
 * @returns 相对路径 → 指纹（遍历失败的分支直接跳过，不使整次快照失败）
 */
export async function snapshotWorkspace(
  root: string,
  exclude: readonly string[] = [],
  sensitivePatterns: readonly string[] = [],
): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map()
  const skipped = new Set(exclude)
  const absoluteRoot = resolve(root)
  await walk(absoluteRoot, '', snapshot, skipped, sensitivePatterns)
  return snapshot
}

async function walk(
  absoluteDir: string,
  relativeDir: string,
  snapshot: WorkspaceSnapshot,
  exclude: ReadonlySet<string>,
  sensitivePatterns: readonly string[],
): Promise<void> {
  if (snapshot.size >= SNAPSHOT_MAX_ENTRIES) return
  let entries
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true })
  } catch {
    // 目录不可读（权限/竞态删除）：该分支不参与快照，也不影响其余文件
    return
  }
  for (const entry of entries) {
    if (snapshot.size >= SNAPSHOT_MAX_ENTRIES) return
    if (exclude.has(entry.name)) continue
    const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    const absolute = join(absoluteDir, entry.name)
    if (entry.isDirectory()) {
      await walk(absolute, relative, snapshot, exclude, sensitivePatterns)
      continue
    }
    // 符号链接一律跳过：产物必须是本工作区内的真实文件（避免指向外部路径）
    if (!entry.isFile()) continue
    // 敏感文件模式匹配排除（T4 防护）
    if (sensitivePatterns.length > 0 && matchesSensitivePattern(entry.name, sensitivePatterns)) continue
    try {
      const info = await stat(absolute)
      snapshot.set(relative, { bytes: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // 快照期间被删除：忽略
    }
  }
}

/**
 * 简易 glob 匹配：支持 `*`（匹配任意字符）和 `**`（匹配任意路径段）。
 * 模式不含 `/` 时按文件名匹配；含 `/` 时按相对路径匹配。
 */
function matchesSensitivePattern(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(name, pattern)) return true
  }
  return false
}

/** 简易 glob → 正则（`*` → `[^/]*`，`**` → `.*`，其余转义）。 */
function matchGlob(text: string, pattern: string): boolean {
  let regex = '^'
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      regex += '.*'
      i += 2
      // 跳过 trailing /*
      if (pattern[i] === '/') i++
    } else if (ch === '*') {
      regex += '[^/]*'
      i++
    } else if (ch === '?') {
      regex += '[^/]'
      i++
    } else {
      // 转义正则特殊字符
      if (/[.+^${}()|[\]\\]/.test(ch)) regex += '\\'
      regex += ch
      i++
    }
  }
  regex += '$'
  return new RegExp(regex).test(text)
}

/** 单个产物候选。 */
export interface ArtifactCandidate {
  /** 相对工作区的 POSIX 路径。 */
  relPath: string
  bytes: number
}

/** 产物对比结果。 */
export interface ArtifactDiff {
  /** 新增或内容/时间戳变化的文件（按路径排序）。 */
  candidates: ArtifactCandidate[]
  /** 因个数或体积上限被跳过的文件数。 */
  skipped: number
}

/**
 * 对比两次快照，得到本任务的产物候选。
 * @param before 执行前快照
 * @param after 执行后快照
 * @param limits 出站上限（enabled=false 时直接返回空结果）
 * @returns 排序后的候选列表与被跳过计数
 */
export function diffWorkspace(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  limits: Pick<ArtifactLimits, 'enabled' | 'maxFiles' | 'maxFileBytes'>,
): ArtifactDiff {
  if (!limits.enabled) return { candidates: [], skipped: 0 }
  const changed: ArtifactCandidate[] = []
  let skipped = 0
  for (const [relPath, entry] of after) {
    const previous = before.get(relPath)
    if (previous !== undefined && previous.bytes === entry.bytes && previous.mtimeMs === entry.mtimeMs) {
      continue
    }
    if (entry.bytes > limits.maxFileBytes) {
      skipped += 1
      continue
    }
    if (changed.length >= limits.maxFiles) {
      skipped += 1
      continue
    }
    changed.push({ relPath, bytes: entry.bytes })
  }
  changed.sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0))
  return { candidates: changed, skipped }
}

/** 工作区绝对路径 → 相对 POSIX 路径（快照键格式）。 */
export function relativeOf(root: string, absolutePath: string): string {
  const prefix = resolve(root).endsWith(sep) ? resolve(root) : `${resolve(root)}${sep}`
  return resolve(absolutePath).slice(prefix.length).split(sep).join('/')
}
