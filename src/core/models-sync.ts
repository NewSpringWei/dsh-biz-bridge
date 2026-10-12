/**
 * 跨 profile 的模型配置同步（api.md §16）。
 *
 * **问题**：桥接 profile 是 headless、provider 目录按 profile 存，所以在 dsh-web 里配好的模型
 * 桥接进程看不见。两个 profile 是两个进程、没有 IPC——唯一的通道是**读对方的补丁文件**：
 * `<DSH_HOME>/profiles/<源 profile>/cordis.patch.yml`（`dsh-web.cmd` 用的就是 `--profile web`）。
 *
 * **方向单一**：只读源、只写自己（经宿主 `settings` 服务，与 dsh-web 的 Models 页同一条路径）。
 * 源 profile 不会被本插件改动。
 *
 * **三条纪律**：
 * 1. 源必须是**显式配置**的 profile 名（`models.syncFromProfile`），不自动猜；
 * 2. **只同步 provider 段**：默认模型（`agent-default-model`）属于通道自选，不跟着交互侧变；
 * 3. **失败绝不清空**：源缺失 / 解析失败 / 段为空 / 段里含 `!!js` → 保留上一份可用集合并告警。
 */

import { createHash } from 'node:crypto'
import { DEFAULT_SCHEMA, Type, load as parseYaml } from 'js-yaml'
import type { SettingsLike } from '../shared/runtime.ts'

/** `!!js` 表达式在补丁里是合法的（整份文件允许），但 provider 段里它无法同步。 */
class JsExpression {
  // 注意：测试经 Node 原生 type-stripping 运行，**不能**用 TS 参数属性（`constructor(readonly x)`）。
  readonly source: string

  constructor(source: string) {
    this.source = source
  }
}

const JS_TAG_NAME = 'tag:yaml.org,2002:js'
const SCHEMA = DEFAULT_SCHEMA.extend([
  new Type(JS_TAG_NAME, { kind: 'scalar', construct: (data: unknown) => new JsExpression(String(data)) }),
])

/** 同步源：显式 profile 名 + 补丁路径 + 读取实现（注入以便单测）。 */
export interface ModelSyncSource {
  profile: string
  path: string
  read: () => Promise<string>
}

/** 一次同步的结果（也作为免签名触发端点的响应体）。 */
export interface ModelSyncOutcome {
  /** `applied` 已写入 | `unchanged` 指纹未变 | `skipped` 未配置/服务缺失 | `failed` 源不可用（已保留上一份）。 */
  status: 'applied' | 'unchanged' | 'skipped' | 'failed'
  reason: string
  profile?: string
  path?: string
  /** 已生效的 provider 路由名。 */
  routes?: string[]
  /** 写入后该条目的 settings 修订号。 */
  revision?: number | null
}

/** 由调用方注入的日志（同步发生在插件自身的日志口径里）。 */
export type ModelSyncLog = (level: 'info' | 'warn', message: string) => void

/** 进程内的同步状态：指纹用于"内容没变就不落盘"。 */
export interface ModelSyncState {
  fingerprint?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 子树里是否含 `!!js` 表达式（含则无法同步——那是求值函件，不是数据）。 */
export function containsJsExpression(value: unknown): boolean {
  if (value instanceof JsExpression) return true
  if (Array.isArray(value)) return value.some(containsJsExpression)
  if (isPlainObject(value)) return Object.values(value).some(containsJsExpression)
  return false
}

/**
 * 从 profile 补丁文档里取出指定条目 id 的 `config.providers`。
 *
 * 兼容两种位置：顶层条目（`- id: <entry>`）与 `insert:` 列表内的条目（补丁语义）。
 * @param patch - 解析后的补丁文档（顶层数组）。
 * @param entryId - 条目 id，即 settings 命名空间（`models.settingsNamespace`）。
 * @returns providers 段；文档里没有该条目或没有该段时 undefined。
 */
export function extractProvidersSection(patch: unknown, entryId: string): unknown {
  if (!Array.isArray(patch)) return undefined
  const fromEntry = (entry: unknown): unknown => {
    if (!isPlainObject(entry)) return undefined
    if (entry.id !== entryId) return undefined
    const config = entry.config
    return isPlainObject(config) ? config.providers : undefined
  }
  for (const entry of patch) {
    const direct = fromEntry(entry)
    if (direct !== undefined) return direct
    if (isPlainObject(entry) && Array.isArray(entry.insert)) {
      for (const nested of entry.insert) {
        const found = fromEntry(nested)
        if (found !== undefined) return found
      }
    }
  }
  return undefined
}

/** 解析 profile 补丁文档；`!!js` 会被捕获成标记对象而不是抛错。 */
export function parseProfilePatch(text: string): unknown {
  return parseYaml(text, { schema: SCHEMA })
}

/** 同步结果里回显的 provider 路由名（稳定排序，便于比对与日志）。 */
function routeNames(providers: Record<string, unknown>): string[] {
  return Object.keys(providers).sort()
}

/**
 * 执行一次同步：读源 → 抽 `providers` → 指纹比对 → `settings.replace` 写本 profile。
 *
 * 任何一步失败都返回 `failed`/`skipped` 并**保留下一次机会**（不写、不清空），由调用方决定告警措辞。
 */
export async function syncModelProviders(options: {
  settings: SettingsLike | undefined
  namespace: string
  source: ModelSyncSource | undefined
  state: ModelSyncState
  log: ModelSyncLog
}): Promise<ModelSyncOutcome> {
  const { settings, namespace, source, state, log } = options
  if (source === undefined) {
    return { status: 'skipped', reason: 'models.syncFromProfile is not configured' }
  }
  if (settings === undefined) {
    return { status: 'skipped', reason: 'settings service is not available', profile: source.profile, path: source.path }
  }
  if (!settings.writable) {
    return { status: 'skipped', reason: `profile settings "${settings.documentPath}" is not writable`, profile: source.profile, path: source.path }
  }

  let text: string
  try {
    text = await source.read()
  } catch (error) {
    return {
      status: 'failed',
      reason: `cannot read ${source.path}: ${error instanceof Error ? error.message : String(error)}`,
      profile: source.profile,
      path: source.path,
    }
  }

  let patch: unknown
  try {
    patch = parseProfilePatch(text)
  } catch (error) {
    return {
      status: 'failed',
      reason: `cannot parse ${source.path}: ${error instanceof Error ? error.message : String(error)}`,
      profile: source.profile,
      path: source.path,
    }
  }

  const section = extractProvidersSection(patch, namespace)
  if (section === undefined) {
    return { status: 'skipped', reason: `no "${namespace}" providers section in ${source.path}`, profile: source.profile, path: source.path }
  }
  if (!isPlainObject(section)) {
    return { status: 'failed', reason: `"${namespace}" providers is not an object in ${source.path}`, profile: source.profile, path: source.path }
  }
  if (Object.keys(section).length === 0) {
    return { status: 'skipped', reason: `"${namespace}" providers is empty in ${source.path}`, profile: source.profile, path: source.path }
  }
  if (containsJsExpression(section)) {
    return {
      status: 'failed',
      reason: `"${namespace}" providers in ${source.path} uses !!js, which cannot be synced; write literal values instead`,
      profile: source.profile,
      path: source.path,
    }
  }

  const fingerprint = createHash('sha256').update(JSON.stringify(section)).digest('hex')
  if (fingerprint === state.fingerprint) {
    return {
      status: 'unchanged',
      reason: `already in sync with ${source.path}`,
      profile: source.profile,
      path: source.path,
      routes: routeNames(section),
    }
  }

  try {
    await settings.replace(namespace, { providers: section })
  } catch (error) {
    // 适配器会拒绝它服务不了的配置（形状合法但语义不可用）——同样保留上一份。
    return {
      status: 'failed',
      reason: `writing "${namespace}" providers failed: ${error instanceof Error ? error.message : String(error)}`,
      profile: source.profile,
      path: source.path,
    }
  }

  state.fingerprint = fingerprint
  const revision = settings.describe().find(entry => entry.ns === namespace)?.revision ?? null
  const routes = routeNames(section)
  log('info', `模型配置已同步：${source.path} → ${namespace}（${routes.length} 个 provider：${routes.join(', ')}）`)
  return { status: 'applied', reason: `synced from ${source.path}`, profile: source.profile, path: source.path, routes, revision }
}
