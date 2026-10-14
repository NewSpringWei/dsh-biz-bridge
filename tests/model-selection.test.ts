/**
 * 会话级模型选择的判定与日志文案（§5.2.3）。
 *
 * 这里钉的是**日志该不该出现**：每次请求都刷一行会把真正的切换埋掉，
 * 而"只换 reasoningEffort"同样是一次路由变化、必须记。两种错法都不会报错，
 * 只会让运维在日志里找不着北，所以当契约测。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelSelectionInstallLog, modelSwitchLog, sameModelSelection } from '../src/core/model-selection.ts'

const XIAOMI = { provider: 'xiaomi', model: 'mimo-v2.6-flash' }
const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash' }

test('sameModelSelection：三个字段全等才算同一路由', () => {
  assert.equal(sameModelSelection(XIAOMI, { ...XIAOMI }), true)
  assert.equal(sameModelSelection(XIAOMI, DEEPSEEK), false)
  assert.equal(sameModelSelection(XIAOMI, { provider: 'xiaomi', model: 'mimo-v2.6-pro' }), false)
  // 只换 effort 也是换了一次路由配置
  assert.equal(sameModelSelection({ ...XIAOMI, reasoningEffort: 'high' }, { ...XIAOMI, reasoningEffort: 'low' }), false)
  assert.equal(sameModelSelection({ ...XIAOMI, reasoningEffort: 'high' }, { ...XIAOMI, reasoningEffort: 'high' }), true)
  // 有与没有 effort 不等价
  assert.equal(sameModelSelection({ ...XIAOMI, reasoningEffort: 'high' }, XIAOMI), false)
})

test('sameModelSelection：undefined 只与 undefined 相同', () => {
  assert.equal(sameModelSelection(undefined, undefined), true)
  assert.equal(sameModelSelection(undefined, XIAOMI), false)
  assert.equal(sameModelSelection(XIAOMI, undefined), false)
})

test('modelSwitchLog：未变返回 undefined（不刷屏）', () => {
  assert.equal(modelSwitchLog('s1', XIAOMI, { ...XIAOMI }), undefined)
  assert.equal(modelSwitchLog('s1', undefined, undefined as never), undefined)
})

test('modelSwitchLog：首次指定与切换是两条不同的话', () => {
  const first = modelSwitchLog('biz-a:stream:s1', undefined, XIAOMI)
  assert.ok(first !== undefined)
  assert.match(first, /首次指定 xiaomi\/mimo-v2\.6-flash/)
  assert.match(first, /下一步请求生效/)

  const switched = modelSwitchLog('biz-a:stream:s1', XIAOMI, DEEPSEEK)
  assert.ok(switched !== undefined)
  assert.match(switched, /由 xiaomi\/mimo-v2\.6-flash 切到 deepseek-official\/deepseek-flash/)
  assert.match(switched, /对话上下文保留/)

  // effort 变化也要记，并写进文案
  const effort = modelSwitchLog('s1', XIAOMI, { ...XIAOMI, reasoningEffort: 'high' })
  assert.ok(effort !== undefined)
  assert.match(effort, /effort=high/)
})

test('modelSelectionInstallLog：未指定时如实写成"沿用宿主默认"', () => {
  assert.match(modelSelectionInstallLog('s1', DEEPSEEK), /已装载到 agent → deepseek-official\/deepseek-flash/)
  assert.match(modelSelectionInstallLog('s1', undefined), /未指定，沿用宿主默认模型/)
})
