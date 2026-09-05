/**
 * 第一方参考实现 · 开发调试工具 的静态资源加载（§11）。
 *
 * 页面资源位于包内 public/static/（插件运行时沿模块目录向上找含 package.json
 * 的包根，再取 public/static/，兼容 dev 源码与打包产物两种深度）。激活时一次性
 * 读入内存；读取失败以最小兜底页/空文件占位，不阻塞插件核心功能。
 *
 * 资源清单：
 *   index.html   入口导航
 *   admin.html   管理运维（管理级验签）
 *   client.html  接入测试（业务级验签）
 *   utils.html   工具（免验签）
 *   common.js    共享逻辑（验签 / 请求 / UI 辅助）
 *   style.css    共享样式
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 静态资源名 → 文件内容。 */
export type StaticFiles = Record<string, string>

export const STATIC_NAMES = [
  'index.html',
  'admin.html',
  'client.html',
  'utils.html',
  'common.js',
  'style.css',
] as const

/** 向上查找包根（含 package.json 的最近祖先目录）。 */
function packageRoot(start: string): string {
  let current = start
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(current, 'package.json'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
export const STATIC_DIR = join(packageRoot(moduleDir), 'public', 'static')

function fallbackPage(name: string): string {
  return [
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8">',
    '<title>dsh-biz-bridge</title>',
    '<body style="font-family:system-ui;padding:32px"><h2>dsh-biz-bridge</h2>',
    `<p>静态资源 ${name} 缺失（public/static/${name}）。这是第一方参考/调试页面，缺失不影响插件 API。</p>`,
    '</body></html>',
  ].join('\n')
}

/** 读取全部静态资源；缺失项以兜底占位并记录日志。 */
export function loadStaticFiles(log: (message: string) => void): StaticFiles {
  const files: StaticFiles = {}
  for (const name of STATIC_NAMES) {
    const path = join(STATIC_DIR, name)
    try {
      files[name] = readFileSync(path, 'utf8')
      log(`static asset loaded: ${path}`)
    } catch (error: unknown) {
      const isHtml = name.endsWith('.html')
      files[name] = isHtml ? fallbackPage(name) : ''
      log(`static asset unavailable (${path}): ${(error as Error).message}; using fallback`)
    }
  }
  return files
}
