/**
 * HTTP 层工具：body 读取（1MB 上限，§6.3.1）、统一 JSON/SSE 序列化与错误映射。
 * 基于 node:http 原生响应生命周期（webServer 路由持有完整生命周期，§6.1）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BizError, ERROR_HTTP_STATUS, PayloadTooLargeError } from '../shared/errors.ts'

/** 请求体上限（§6.3.1 默认 1MB）。 */
export const MAX_BODY_BYTES = 1024 * 1024

/** 读取请求体（同步限额）。 */
export async function readBody(req: IncomingMessage, limitBytes = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limitBytes) {
      req.destroy()
      throw new PayloadTooLargeError(`request body exceeds ${limitBytes} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** 解析 JSON 请求体；非法 JSON → BizError INVALID_REQUEST。 */
export function parseJsonBody(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {}
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('body must be a JSON object')
    }
    return value as Record<string, unknown>
  } catch (error: unknown) {
    if (error instanceof BizError) throw error
    throw new BizError('INVALID_REQUEST', `request body is not valid JSON: ${(error as Error).message}`)
  }
}

/** 写 JSON 响应。 */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  // headersSent 也必须挡：若 SSE 已经 beginSse() 发送了响应头，再 writeHead 会抛
  // ERR_HTTP_HEADERS_SENT，使错误处理路径自身崩溃、连接既不收尾也不报错（复审 F3）。
  if (res.writableEnded || res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** 统一错误响应（§6.3.1）。 */
export function sendError(res: ServerResponse, error: unknown): void {
  if (res.writableEnded || res.headersSent) return
  if (error instanceof BizError) {
    writeJson(res, ERROR_HTTP_STATUS[error.code], error.toBody())
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, ERROR_HTTP_STATUS.INTERNAL, {
    error: { code: 'INTERNAL', message, details: {} },
  })
}

/** 开始 SSE 响应（§6.4.1）。 */
export function beginSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  })
  // 打开即写注释行，让代理确认通道存活。
  res.write(': connected\n\n')
}

/** 写一条 data 帧（§6.4.1：data: {…}）。 */
export function sseData(res: ServerResponse, payload: Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/** SSE keepalive 注释行（`: ping`，§6.4.1 每 15s）。 */
export function ssePing(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return
  res.write(': ping\n\n')
}

/** 结束 SSE。 */
export function endSse(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return
  res.end()
}
