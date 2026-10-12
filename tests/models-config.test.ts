/**
 * 模型目录与 provider 配置面（api.md §11 / §15）。
 *
 * 覆盖三件在改造前会静默的事：
 *   ① provider 级查询失败过去被 `catch` 吞掉，目录里只是"少一项"——现在如实上报 `error`；
 *   ② provider 段的形状校验与写入（写入走宿主 settings 服务，与 dsh-web 的 Models 页同一路径）；
 *   ③ 配置面读到的来源（命名空间 / 文档路径 / 修订号），让"配在哪、生效了吗"可回答。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectModelCatalog, modelCatalogSummary, readModelsConfig, validateProvidersSection, writeModelProviders,
} from '../src/core/models-config.ts'
import type { LlmLike, SettingsLike } from '../src/shared/runtime.ts'
import { DEFAULTS, normalizeConfig } from '../src/config/config.ts'
import { Config } from '../src/index.ts'

type ModelStub = { id: string; name: string; description?: string; inputModalities?: readonly string[] }

/** 最小 LLM 假实现：可指定某 provider 查询失败、是否提供可配置目录。 */
function fakeLlm(options: {
  providers?: Array<{ id: string; name: string }>
  models?: Record<string, ModelStub[]>
  failing?: string[]
  configurable?: boolean
} = {}): LlmLike {
  const providers = options.providers ?? [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'xiaomi', name: 'xiaomi' },
  ]
  const models = options.models ?? {
    'deepseek-official': [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', inputModalities: ['text', 'image'] }],
    xiaomi: [{ id: 'mimo-v2.6-flash', name: 'mimo-v2.6-flash' }],
  }
  return {
    listProviders: () => providers,
    async listModels(provider: string) {
      if (options.failing?.includes(provider) === true) throw new Error(`adapter for "${provider}" is unavailable`)
      return (models[provider] ?? []).map(model => ({ provider, ...model }))
    },
    async resolveModelInfo(provider: string, model: string) {
      if (model === 'no-details') throw new Error('model has no resolvable details')
      return {
        provider,
        id: model,
        name: model,
        defaultMaxTokens: 8192,
        reasoning: { efforts: [{ id: 'low', name: 'Low', description: 'fast' }] },
      }
    },
    ...options.configurable === false ? {} : {
      listConfigurableProviders: () => providers.map(provider => ({
        provider: provider.id,
        displayName: provider.name,
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', provider.id],
        declared: false,
      })),
    },
  }
}

/** 最小 settings 假实现；记录写入以便断言。 */
function fakeSettings(options: {
  user?: unknown
  writable?: boolean
  revision?: number
} = {}): SettingsLike & { writes: Array<{ ns: string; section: unknown; expectedRevision?: number }> } {
  const writes: Array<{ ns: string; section: unknown; expectedRevision?: number }> = []
  let revision = options.revision ?? 3
  let user: unknown = options.user
  return {
    documentPath: 'C:/Users/admin/.dsh/profiles/bizbridge/cordis.patch.yml',
    writable: options.writable ?? true,
    describe: () => [{ ns: 'llm-pi-ai', revision, value: user, user }],
    async replace(ns: string, section: object, expectedRevision?: number) {
      writes.push({ ns, section, expectedRevision })
      user = section
      revision += 1
    },
    writes,
  }
}

test('目录：provider 与模型逐项投影（含 reasoning/maxTokens）', async () => {
  const catalog = await collectModelCatalog(fakeLlm())
  assert.equal(catalog.providers.length, 2)
  const first = catalog.providers[0]!
  assert.equal(first.id, 'deepseek-official')
  assert.equal(first.error, undefined)
  assert.deepEqual(first.models[0], {
    id: 'deepseek-flash',
    name: 'DeepSeek-V41-Flash',
    description: null,
    inputModalities: ['text', 'image'],
    reasoningEfforts: [{ id: 'low', name: 'Low', description: 'fast' }],
    defaultMaxTokens: 8192,
  })
})

test('目录：provider 级失败如实上报，不再静默少一项', async () => {
  const catalog = await collectModelCatalog(fakeLlm({ failing: ['xiaomi'] }))
  const failed = catalog.providers.find(provider => provider.id === 'xiaomi')
  assert.notEqual(failed, undefined, '失败 provider 必须仍出现在目录里')
  assert.deepEqual(failed!.models, [])
  assert.match(failed!.error!, /unavailable/)
  assert.equal(catalog.providers.find(provider => provider.id === 'deepseek-official')!.error, undefined)
})

test('目录：单模型详情查询失败只损失详情，不影响目录', async () => {
  const catalog = await collectModelCatalog(fakeLlm({
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: { 'deepseek-official': [{ id: 'no-details', name: 'No Details' }] },
  }))
  const model = catalog.providers[0]!.models[0]!
  assert.equal(model.id, 'no-details')
  assert.equal(model.reasoningEfforts, null)
  assert.equal(model.defaultMaxTokens, null)
})

test('provider 段校验：只做结构校验，字段语义交给适配器', () => {
  assert.deepEqual(validateProvidersSection({ xiaomi: { apiKeyEnv: 'XIAOMI_API_KEY' } }), {
    xiaomi: { apiKeyEnv: 'XIAOMI_API_KEY' },
  })
  assert.deepEqual(validateProvidersSection({}), {})
  assert.throws(() => validateProvidersSection(undefined), /providers must be an object/)
  assert.throws(() => validateProvidersSection([]), /providers must be an object/)
  assert.throws(() => validateProvidersSection('xiaomi'), /providers must be an object/)
  assert.throws(() => validateProvidersSection({ '  ': {} }), /non-empty route names/)
  assert.throws(() => validateProvidersSection({ xiaomi: ['not-an-object'] }), /providers\["xiaomi"\] must be an object/)
})

test('配置面读取：目录 + settings 来源（命名空间 / 文档 / 修订号 / 可配置目录）', async () => {
  const settings = fakeSettings({ user: { providers: { xiaomi: { apiKeyEnv: 'XIAOMI_API_KEY' } } }, revision: 7 })
  const view = await readModelsConfig(fakeLlm(), settings, 'llm-pi-ai')
  assert.equal(view.namespace, 'llm-pi-ai')
  assert.equal(view.documentPath, settings.documentPath)
  assert.equal(view.writable, true)
  assert.equal(view.revision, 7)
  assert.deepEqual(view.configured, { xiaomi: { apiKeyEnv: 'XIAOMI_API_KEY' } })
  assert.deepEqual(view.configurable!.map(entry => entry.provider), ['deepseek-official', 'xiaomi'])
  assert.equal(view.providers.length, 2)
})

test('配置面读取：settings 服务缺失时只读降级，目录照常', async () => {
  const view = await readModelsConfig(fakeLlm({ configurable: false }), undefined, 'llm-pi-ai')
  assert.equal(view.documentPath, null)
  assert.equal(view.writable, false)
  assert.equal(view.revision, null)
  assert.equal(view.configured, null)
  assert.equal(view.configurable, null)
  assert.equal(view.providers.length, 2)
})

test('provider 段写入：走 settings.replace，并用 expected_revision 做并发保护', async () => {
  const settings = fakeSettings({ revision: 4 })
  const providers = { xiaomi: { apiKeyEnv: 'XIAOMI_API_KEY', models: [{ id: 'mimo-v2.6-flash' }] } }
  const view = await writeModelProviders(fakeLlm(), settings, 'llm-pi-ai', providers, 4)
  assert.deepEqual(settings.writes, [{ ns: 'llm-pi-ai', section: { providers }, expectedRevision: 4 }])
  assert.deepEqual(view.configured, providers)
  assert.equal(view.revision, 5, '回读到的修订号应已推进')
})

test('provider 段写入：无 settings 服务 → 501 语义；profile 不可写 → 400 语义', async () => {
  await assert.rejects(
    () => writeModelProviders(fakeLlm(), undefined, 'llm-pi-ai', {}),
    (error: Error & { code?: string }) => error.code === 'NOT_IMPLEMENTED',
  )
  await assert.rejects(
    () => writeModelProviders(fakeLlm(), fakeSettings({ writable: false }), 'llm-pi-ai', {}),
    (error: Error & { code?: string }) => error.code === 'INVALID_REQUEST',
  )
})

test('启动摘要：provider/模型计数，失败就地标出', async () => {
  const ok = await modelCatalogSummary(fakeLlm())
  assert.equal(ok.providerCount, 2)
  assert.equal(ok.modelCount, 2)
  assert.match(ok.text, /2 个 provider、2 个模型/)

  const withFailure = await modelCatalogSummary(fakeLlm({ failing: ['xiaomi'] }))
  assert.match(withFailure.text, /xiaomi\(查询失败: .*unavailable\)/)
})

test('models 配置：缺省值与 schema 双源一致（防漂移）', () => {
  const c = normalizeConfig(undefined)
  assert.equal(c.models.settingsNamespace, 'llm-pi-ai')
  assert.equal(normalizeConfig({ models: { settingsNamespace: 'llm-other' } }).models.settingsNamespace, 'llm-other')
  assert.throws(() => normalizeConfig({ models: { settingsNamespace: '  ' } }), /models\.settingsNamespace/)
  const fromSchema = Config({}) as { models: unknown }
  assert.deepEqual(JSON.parse(JSON.stringify(fromSchema.models)), JSON.parse(JSON.stringify(DEFAULTS.models)))
})
