/**
 * 跨 profile 模型同步（api.md §16）。
 *
 * 重点是三条纪律在代码里真的成立：
 *   ① 只同步 `providers` 段（默认模型不跟着动）；
 *   ② 源不可用 / 含 `!!js` / 段为空 → **不写、不清空**（保留上一份可用集合）；
 *   ③ 内容没变不落盘（指纹），所以"每次启动检查"与"反复点同步"都不产生无谓写入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  containsJsExpression, extractProvidersSection, parseProfilePatch, syncModelProviders,
  type ModelSyncSource, type ModelSyncState,
} from '../src/core/models-sync.ts'
import type { SettingsLike } from '../src/shared/runtime.ts'

const PATCH = `# profile 补丁
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      xiaomi:
        apiKeyEnv: XIAOMI_API_KEY
        models:
          - id: mimo-v2.6-flash
            name: mimo-v2.6-flash
            contextWindow: 1024000
      qwen:
        apiKeyEnv: QWEN_API_KEY
        baseURL: https://example.invalid/v1
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
`

/** 极简 settings 假实现：记录写入，模拟 describe 的修订号推进。 */
function fakeSettings(options: { writable?: boolean; revision?: number } = {}): SettingsLike & {
  writes: Array<{ ns: string; section: unknown }>
} {
  const writes: Array<{ ns: string; section: unknown }> = []
  let revision = options.revision ?? 1
  let user: unknown
  return {
    documentPath: 'C:/dsh/profiles/bizbridge/cordis.patch.yml',
    writable: options.writable ?? true,
    describe: () => [{ ns: 'llm-pi-ai', revision, value: user, user }],
    async replace(ns: string, section: object) {
      writes.push({ ns, section })
      user = section
      revision += 1
    },
    writes,
  }
}

/** 同步源假实现：给定文本或错误。 */
function fakeSource(content: string | Error, profile = 'web'): ModelSyncSource {
  return {
    profile,
    path: `C:/dsh/profiles/${profile}/cordis.patch.yml`,
    read: async () => {
      if (content instanceof Error) throw content
      return content
    },
  }
}

const quiet = () => {}

test('方言：`!!js` 解析成标记而不抛错，且可被检出', () => {
  const doc = parseProfilePatch('- id: x\n  config:\n    v: !!js "process.env.X"\n')
  const value = (doc as Array<{ config: { v: unknown } }>)[0]!.config.v
  assert.equal(containsJsExpression(value), true)
  assert.equal(containsJsExpression({ a: [1, 'b'] }), false)
})

test('抽取：按条目 id 找 providers 段（含 insert 列表内），缺失返回 undefined', () => {
  const doc = parseProfilePatch(PATCH)
  const providers = extractProvidersSection(doc, 'llm-pi-ai') as Record<string, unknown>
  assert.deepEqual(Object.keys(providers).sort(), ['qwen', 'xiaomi'])
  assert.equal(extractProvidersSection(doc, 'agent-default-model'), undefined)
  assert.equal(extractProvidersSection(doc, 'nope'), undefined)

  const inserted = parseProfilePatch('- insert:\n    - id: llm-pi-ai\n      config:\n        providers:\n          zai: { apiKeyEnv: ZAI_API_KEY }\n')
  assert.deepEqual(Object.keys(extractProvidersSection(inserted, 'llm-pi-ai') as object), ['zai'])
})

test('同步：只写 providers 段，默认模型不动；路由排序稳定', async () => {
  const settings = fakeSettings({ revision: 7 })
  const state: ModelSyncState = {}
  const outcome = await syncModelProviders({
    settings, namespace: 'llm-pi-ai', source: fakeSource(PATCH), state, log: quiet,
  })
  assert.equal(outcome.status, 'applied')
  assert.deepEqual(outcome.routes, ['qwen', 'xiaomi'])
  assert.equal(outcome.revision, 8)
  assert.equal(settings.writes.length, 1)
  const written = settings.writes[0]!
  assert.equal(written.ns, 'llm-pi-ai')
  assert.deepEqual(Object.keys(written.section as object), ['providers'], '一次写入只带 providers')
  // 默认模型（agent-default-model 的 reasoningEffort=high）没有被带过来
  assert.equal(JSON.stringify(written.section).includes('reasoningEffort'), false)
})

test('同步：内容没变就不落盘（指纹），变了才重新写', async () => {
  const settings = fakeSettings()
  const state: ModelSyncState = {}
  const first = await syncModelProviders({ settings, namespace: 'llm-pi-ai', source: fakeSource(PATCH), state, log: quiet })
  const second = await syncModelProviders({ settings, namespace: 'llm-pi-ai', source: fakeSource(PATCH), state, log: quiet })
  assert.equal(first.status, 'applied')
  assert.equal(second.status, 'unchanged')
  assert.equal(settings.writes.length, 1)

  const changed = PATCH.replace('mimo-v2.6-flash', 'mimo-v2.7-flash')
  const third = await syncModelProviders({ settings, namespace: 'llm-pi-ai', source: fakeSource(changed), state, log: quiet })
  assert.equal(third.status, 'applied')
  assert.equal(settings.writes.length, 2)
})

test('同步：源读取失败 / 段为空 / 含 !!js → 一律不写，保留上一份', async () => {
  const settings = fakeSettings()
  const state: ModelSyncState = {}

  const missing = await syncModelProviders({ settings, namespace: 'llm-pi-ai', source: fakeSource(new Error('ENOENT')), state, log: quiet })
  assert.equal(missing.status, 'failed')
  assert.match(missing.reason, /cannot read/)

  const noSection = await syncModelProviders({
    settings, namespace: 'llm-pi-ai', source: fakeSource('- id: other\n  config: {}\n'), state, log: quiet,
  })
  assert.equal(noSection.status, 'skipped')

  const empty = await syncModelProviders({
    settings, namespace: 'llm-pi-ai', source: fakeSource('- id: llm-pi-ai\n  config:\n    providers: {}\n'), state, log: quiet,
  })
  assert.equal(empty.status, 'skipped')

  const withJs = await syncModelProviders({
    settings,
    namespace: 'llm-pi-ai',
    source: fakeSource('- id: llm-pi-ai\n  config:\n    providers:\n      x:\n        baseURL: !!js "process.env.BASE"\n'),
    state,
    log: quiet,
  })
  assert.equal(withJs.status, 'failed')
  assert.match(withJs.reason, /!!js/)

  assert.equal(settings.writes.length, 0, '四种失败都不应产生写入')
})

test('同步：失败不会破坏下一次成功（指纹不被污染）', async () => {
  const settings = fakeSettings()
  const state: ModelSyncState = {}
  await syncModelProviders({ settings, namespace: 'llm-pi-ai', source: fakeSource(new Error('boom')), state, log: quiet })
  const ok = await syncModelProviders({ settings, namespace: 'llm-pi-ai', source: fakeSource(PATCH), state, log: quiet })
  assert.equal(ok.status, 'applied')
  assert.equal(settings.writes.length, 1)
})

test('同步：未配置源 / 无 settings 服务 / profile 不可写 → skipped，且不抛错', async () => {
  const state: ModelSyncState = {}
  const noConfig = await syncModelProviders({ settings: fakeSettings(), namespace: 'llm-pi-ai', source: undefined, state, log: quiet })
  assert.equal(noConfig.status, 'skipped')
  assert.match(noConfig.reason, /syncFromProfile/)

  const noService = await syncModelProviders({ settings: undefined, namespace: 'llm-pi-ai', source: fakeSource(PATCH), state, log: quiet })
  assert.equal(noService.status, 'skipped')
  assert.match(noService.reason, /settings service/)

  const settings = fakeSettings({ writable: false })
  const readOnly = await syncModelProviders({ settings, namespace: 'llm-pi-ai', source: fakeSource(PATCH), state, log: quiet })
  assert.equal(readOnly.status, 'skipped')
  assert.equal(settings.writes.length, 0)
})

test('同步：适配器拒绝写入时如实上报 failed，不更新指纹', async () => {
  const settings = fakeSettings()
  settings.replace = async () => { throw new Error('llm-pi-ai: provider "xiaomi" sets "provider", which moved to the providers dict key') }
  const state: ModelSyncState = {}
  const outcome = await syncModelProviders({ settings, namespace: 'llm-pi-ai', source: fakeSource(PATCH), state, log: quiet })
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.reason, /writing "llm-pi-ai" providers failed/)
  assert.equal(state.fingerprint, undefined)
})
