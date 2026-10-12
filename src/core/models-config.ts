/**
 * 模型目录与 provider 配置面（api.md §11 / §15）。
 *
 * 两件事放在同一模块，因为它们读的是同一份宿主 LLM 注册表：
 *
 * - **目录投影**：provider → model → reasoning efforts。provider 级失败**如实上报**
 *   （此前是 `catch` 后静默跳过，于是"配错 profile / adapter 挂掉 / 本来就只配了一个"
 *   在响应里长得一模一样——这是本插件最难定位的一类现象）。
 * - **provider 段的读写**：桥接 profile 是 headless，没有配置界面；provider 路由由**本 profile
 *   的 settings 段**供给（条目 id 由 `models.settingsNamespace` 指定，默认 `llm-pi-ai`）。
 *   写入走宿主的 `settings` 服务——与 dsh-web 的 Models 页**同一条**官方写入路径，
 *   不是另开事实源。
 *
 * 与 DSH 解耦：只依赖 `shared/runtime.ts` 的 `LlmLike` / `SettingsLike` 最小面，可脱离宿主单测。
 */

import { InvalidRequestError, NotImplementedError } from '../shared/errors.ts'
import type { LlmLike, SettingsLike } from '../shared/runtime.ts'

/** 目录里的一个模型条目（对外契约见 api.md §11）。 */
export interface CatalogModel {
  id: string
  name: string
  description: string | null
  inputModalities: readonly string[] | null
  reasoningEfforts: Array<{ id: string; name: string; description: string | null }> | null
  defaultMaxTokens: number | null
}

/** 目录里的一个 provider 条目；`error` 只在查询该 provider 的模型失败时出现。 */
export interface CatalogProvider {
  id: string
  name: string
  models: CatalogModel[]
  error?: string
}

/** 模型目录响应（`POST /api/v1/models` 与配置面共用）。 */
export interface ModelCatalog {
  providers: CatalogProvider[]
}

/**
 * 宿主 `llm.listConfigurableProviders()` 的条目（原样透出，供配置面显示 settings 地址）。
 * 该能力在 0.2.0 上存在；缺失时不透出该字段。
 */
export interface ConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  declared: boolean
  error?: string
}

/** provider 配置面视图（`POST /api/v1/admin/models` 的响应体）。 */
export interface ModelsConfigView extends ModelCatalog {
  /** 承载 provider 路由的宿主条目 id。 */
  namespace: string
  /** 该条目的 settings 文档路径（本 profile 的 cordis.patch.yml）；服务缺失时为 null。 */
  documentPath: string | null
  /** 该 profile 是否接受写入。 */
  writable: boolean
  /** 写入并发保护用的修订号；服务缺失时为 null。 */
  revision: number | null
  /** 当前生效的 providers 段（读不到时为 null）。 */
  configured: unknown
  /** 宿主暴露的可配置 provider 目录；能力缺失时为 null。 */
  configurable: ConfigurableProvider[] | null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 读取单个 provider 的模型列表（含单模型的 reasoning/maxTokens 详情）。 */
async function listModelsOf(llm: LlmLike, provider: string): Promise<CatalogModel[]> {
  const rawModels = await llm.listModels(provider)
  const models: CatalogModel[] = []
  for (const m of rawModels) {
    const model: CatalogModel = {
      id: m.id,
      name: m.name,
      description: m.description ?? null,
      inputModalities: m.inputModalities ?? null,
      reasoningEfforts: null,
      defaultMaxTokens: null,
    }
    // 详情查询失败只损失该模型的 reasoning/maxTokens，不影响目录本身（保留原有语义）。
    try {
      const info = await llm.resolveModelInfo(provider, m.id)
      if (info.reasoning?.efforts) {
        model.reasoningEfforts = info.reasoning.efforts.map(e => ({
          id: e.id,
          name: e.name,
          description: e.description ?? null,
        }))
      }
      if (info.defaultMaxTokens !== undefined) model.defaultMaxTokens = info.defaultMaxTokens
    } catch {
      // 该模型没有详情（例如未声明 reasoning）——不是错误，保持 null。
    }
    models.push(model)
  }
  return models
}

/**
 * 把宿主 LLM 注册表投影成模型目录。
 *
 * provider 级失败不再吞掉：该 provider 仍出现在结果里、`models` 为空、`error` 带原因，
 * 让"目录少一项"与"本来就只配了一个"可区分。
 */
export async function collectModelCatalog(llm: LlmLike): Promise<ModelCatalog> {
  const providers: CatalogProvider[] = []
  for (const provider of llm.listProviders()) {
    try {
      providers.push({ id: provider.id, name: provider.name, models: await listModelsOf(llm, provider.id) })
    } catch (error) {
      providers.push({ id: provider.id, name: provider.name, models: [], error: messageOf(error) })
    }
  }
  return { providers }
}

/** 读取宿主暴露的可配置 provider 目录（能力缺失时 null）。 */
function configurableOf(llm: LlmLike): ConfigurableProvider[] | null {
  if (llm.listConfigurableProviders === undefined) return null
  try {
    return llm.listConfigurableProviders().map(entry => ({
      provider: entry.provider,
      displayName: entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: [...entry.settingsPath],
      declared: entry.declared,
      ...entry.error === undefined ? {} : { error: entry.error },
    }))
  } catch {
    // 目录能力本身报错不应影响模型列表的可用性。
    return null
  }
}

/** 从 settings 表单里取出指定命名空间当前的 user 层值（读不到时 null）。 */
function configuredSection(settings: SettingsLike, namespace: string): { revision: number; value: unknown } | null {
  const descriptor = settings.describe().find(entry => entry.ns === namespace)
  if (descriptor === undefined) return null
  const user: unknown = descriptor.user
  const providers = typeof user === 'object' && user !== null ? (user as { providers?: unknown }).providers : undefined
  return { revision: descriptor.revision, value: providers ?? null }
}

/**
 * 读取模型配置面：实时目录 + 该 profile 的 settings 状态。
 * `settings` 服务缺失（宿主未挂 `dsh-settings`）时相关字段为 null，目录仍照常返回。
 */
export async function readModelsConfig(
  llm: LlmLike,
  settings: SettingsLike | undefined,
  namespace: string,
): Promise<ModelsConfigView> {
  const catalog = await collectModelCatalog(llm)
  const section = settings === undefined ? null : configuredSection(settings, namespace)
  return {
    ...catalog,
    namespace,
    documentPath: settings?.documentPath ?? null,
    writable: settings?.writable ?? false,
    revision: section?.revision ?? null,
    configured: section?.value ?? null,
    configurable: configurableOf(llm),
  }
}

/**
 * 校验 provider 段的基本形状。
 *
 * 只做**结构**校验（dict / 非空 key / 值为对象）：字段级语义归 `llm-pi-ai` 自己——它在配置装载时
 * 校验并**拒绝服务不了的写入**（"refuses a settings write this adapter could not serve"），
 * 插件重复一份 schema 只会产生第二个事实源。
 */
export function validateProvidersSection(value: unknown): Record<string, Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRequestError('providers must be an object keyed by provider route')
  }
  const out: Record<string, Record<string, unknown>> = {}
  for (const [route, profile] of Object.entries(value as Record<string, unknown>)) {
    if (route.trim() === '') throw new InvalidRequestError('providers keys must be non-empty route names')
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
      throw new InvalidRequestError(`providers["${route}"] must be an object`)
    }
    out[route] = profile as Record<string, unknown>
  }
  return out
}

/**
 * 把 provider 段写入**本 profile** 的 settings（`settings.replace`：该段即当前完整集合，
 * 因此删除一个 provider 就是不再列出它）。
 *
 * 写入后回读一次配置面，让调用方立即看到生效结果（路由注册是 live 的）。
 */
export async function writeModelProviders(
  llm: LlmLike,
  settings: SettingsLike | undefined,
  namespace: string,
  providers: unknown,
  expectedRevision?: number,
): Promise<ModelsConfigView> {
  if (settings === undefined) {
    throw new NotImplementedError('settings service is not available: cannot write the provider section')
  }
  if (!settings.writable) {
    throw new InvalidRequestError(`profile settings "${settings.documentPath}" is not writable`)
  }
  const section = validateProvidersSection(providers)
  await settings.replace(namespace, { providers: section }, expectedRevision)
  return await readModelsConfig(llm, settings, namespace)
}

/**
 * 启动时的目录摘要（一行；provider 级失败就地标出）。
 *
 * 存在的理由：headless profile 的 provider 来自本 profile 的 settings 段，配错作用域时
 * 目录会静默少一个 provider；启动日志是唯一一定会被人看到的地方。
 */
export async function modelCatalogSummary(
  llm: LlmLike,
): Promise<{ text: string; providerCount: number; modelCount: number }> {
  const { providers } = await collectModelCatalog(llm)
  const parts = providers.map(provider => provider.error === undefined
    ? `${provider.id}(${provider.models.length})`
    : `${provider.id}(查询失败: ${provider.error})`)
  const modelCount = providers.reduce((sum, provider) => provider.error === undefined ? sum + provider.models.length : sum, 0)
  return {
    text: `${providers.length} 个 provider、${modelCount} 个模型 — ${parts.join(', ')}`,
    providerCount: providers.length,
    modelCount,
  }
}
