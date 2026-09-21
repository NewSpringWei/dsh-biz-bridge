/**
 * 附件转接核心（§6.4.4）：入站 URI 声明校验、拉取落盘、执行期内容块组装。
 *
 * 与 DSH 的耦合一律经端口注入（AttachmentFetcher / AttachmentAdmissionPort），
 * 因此本模块可脱离 DSH 环境做纯单测（tests/attachments.test.ts）。
 *
 * 磁盘约定（§4.2.4）：
 *   入站附件落在 `<client workspace>/attachments/inbound/<taskId>/<name>`；
 *   出站产物即 agent 在 workspace 内的原始文件（不复制），由 core/artifacts.ts 登记。
 *   两者的相对路径都写进 task_attachments.rel_path，下载与再次准入都以它为唯一依据。
 *
 * 时序：提交/入队时即完成拉取与落盘（业务方给的预签名 URI 有有效期，不能拖到执行期），
 * 执行期只做"读本地文件 → DSH 附件准入 → 组装内容块"。
 */

import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { InvalidRequestError } from '../shared/errors.ts'
import type {
  AttachmentRequest, FileAttachmentRefLike, ImageAttachmentRefLike, TaskAttachmentRow, UserContentBlock,
} from '../shared/types.ts'

/** 图片准入允许的媒体类型（与 DSH attachment-local 的 mediaTypes 口径一致）。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** 扩展名 → 图片媒体类型（缺少 mime 声明与响应头时的兜底推断）。 */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** 附件相关配置中本模块消费的部分（字段名与配置节 `attachments` 一一对应，可直接传入）。 */
export interface AttachmentLimits {
  /** 单次请求附件个数上限。 */
  maxItems: number
  /** 单个附件字节上限。 */
  maxFileBytes: number
  /** 单次请求附件总字节上限。 */
  maxTotalBytes: number
  /** 拉取超时（秒）。 */
  fetchTimeout: number
  /** 允许拉取的 host 白名单；空数组表示不限制（仅允许 http/https）。 */
  allowedHosts: readonly string[]
  /** 是否拒绝内网/环回/链路本地地址（默认 true）。 */
  denyInternalHosts: boolean
  /** 重定向链最大跳数（默认 5）。 */
  maxRedirects: number
}

/** 拉取结果。 */
export interface FetchedAttachment {
  data: Uint8Array
  /** 响应头给出的媒体类型（小写、去掉参数）；缺失为 null。 */
  mime: string | null
}

/** URI 拉取端口（真实实现见 createHttpAttachmentFetcher；测试注入 fake）。 */
export type AttachmentFetcher = (
  uri: string,
  options: { timeoutSeconds: number; maxBytes: number },
) => Promise<FetchedAttachment>

/** DSH 附件准入端口（真实实现见 dsh/gateway.ts；测试注入 fake）。 */
export interface AttachmentAdmissionPort {
  /** 图片：校验并持久化，返回 DSH 图片引用。 */
  admitImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<ImageAttachmentRefLike>
  /** 文件：逐字节持久化，返回 DSH 文件引用。 */
  admitFile(input: { data: Uint8Array; name: string }): Promise<FileAttachmentRefLike>
}

/** 已落盘的入站附件（尚未写入账本）。 */
export interface PreparedInbound {
  name: string
  mime: string | null
  bytes: number
  /** 相对 client workspace 的 POSIX 相对路径。 */
  relPath: string
  sourceUri: string
}

/** 判断媒体类型是否为受支持的图片类型。 */
export function isImageMediaType(mime: string | null | undefined): boolean {
  return mime !== null && mime !== undefined && (IMAGE_MEDIA_TYPES as readonly string[]).includes(mime)
}

/** 按扩展名推断图片媒体类型（无法推断返回 null）。 */
export function imageMediaTypeFromName(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return IMAGE_EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null
}

/** 常见扩展名 → MIME（出站产物登记用；未知回落 application/octet-stream）。 */
const COMMON_MIME: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  log: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
}

/** 由文件名推断 MIME。 */
export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return COMMON_MIME[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** 归一化媒体类型：小写并去掉 `;charset=…` 等参数。 */
export function normalizeMime(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return mime === '' ? null : mime
}

/**
 * 校验并归一化请求体的 `attachments` 字段（§6.4.4）。
 * @param value 原始字段值（undefined / null 视为无附件）
 * @param limits 附件配置上限
 * @returns 归一化后的附件声明（保持调用方给定顺序）
 * @throws InvalidRequestError 字段形态、个数、URI 或 host 白名单不合法
 */
export function parseAttachmentRequests(
  value: unknown,
  limits: Pick<AttachmentLimits, 'maxItems' | 'allowedHosts' | 'denyInternalHosts'>,
): AttachmentRequest[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new InvalidRequestError('attachments must be an array')
  if (value.length > limits.maxItems) {
    throw new InvalidRequestError(`attachments exceeds the limit of ${limits.maxItems} item(s) per request`)
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new InvalidRequestError(`attachments[${index}] must be an object`)
    }
    const raw = entry as Record<string, unknown>
    const type = raw.type
    if (type !== 'image' && type !== 'file') {
      throw new InvalidRequestError(`attachments[${index}].type must be "image" or "file"`)
    }
    const uri = raw.uri
    if (typeof uri !== 'string' || uri.trim() === '') {
      throw new InvalidRequestError(`attachments[${index}].uri must be a non-empty string`)
    }
    assertAttachmentUri(uri, limits.allowedHosts, index, limits.denyInternalHosts)
    if (raw.name !== undefined && typeof raw.name !== 'string') {
      throw new InvalidRequestError(`attachments[${index}].name must be a string`)
    }
    if (raw.mime !== undefined && typeof raw.mime !== 'string') {
      throw new InvalidRequestError(`attachments[${index}].mime must be a string`)
    }
    const request: AttachmentRequest = { type, uri }
    if (typeof raw.name === 'string' && raw.name.trim() !== '') request.name = raw.name
    if (typeof raw.mime === 'string' && raw.mime.trim() !== '') request.mime = raw.mime
    return request
  })
}

/** URI 必须是 http/https 绝对地址；白名单非空时 host（含端口）必须在其中。 */
function assertAttachmentUri(
  uri: string,
  allowedHosts: readonly string[],
  index: number,
  denyInternalHosts: boolean,
): void {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new InvalidRequestError(`attachments[${index}].uri must be an absolute http(s) URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidRequestError(`attachments[${index}].uri must use http or https`)
  }
  if (allowedHosts.length > 0 && !allowedHosts.includes(parsed.host)) {
    throw new InvalidRequestError(`attachments[${index}].uri host "${parsed.host}" is not allowed`)
  }
  if (denyInternalHosts && isInternalHost(parsed.hostname)) {
    throw new InvalidRequestError(`attachments[${index}].uri host "${parsed.hostname}" is an internal/private address and is blocked`)
  }
}

/**
 * 判断主机名是否为内网/环回/链路本地地址（SSRF 防护）。
 *
 * IPv6 一律**解析成 16 字节后再判段**，不做字符串前缀匹配——URL 解析器会把
 * `[::ffff:127.0.0.1]` 归一化成 `[::ffff:7f00:1]`，前缀式判断会漏掉这类映射写法，
 * 从而可完整读取内网服务。
 *
 * 覆盖：IPv4 私有/环回/链路本地/保留段；IPv6 未指定/环回/ULA/链路本地/多播/
 * 文档段/IPv4 映射/NAT64/6to4；以及 localhost / *.local / *.internal 保留主机名。
 */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|]$/g, '')
  // 保留主机名
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true
  // 纯 IPv4（点分十进制）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isInternalIpv4(h)
  // IPv6（含含冒号的字面量；解析失败按"不安全"处理，宁可拦错）
  if (h.includes(':')) {
    const bytes = parseIpv6Bytes(h)
    if (bytes === null) return true
    return isInternalIpv6(bytes)
  }
  return false
}

/**
 * 把 IPv6 字面量解析为 16 字节。支持 `::` 压缩、内嵌 IPv4（`::ffff:127.0.0.1`）、
 * zone id（`fe80::1%eth0`）。解析失败返回 null。
 */
export function parseIpv6Bytes(input: string): Uint8Array | null {
  // 去 zone id
  let text = input.split('%')[0] ?? input
  if (text === '') return null
  // 处理内嵌 IPv4 尾部（转为两个 16 位组）
  const lastColon = text.lastIndexOf(':')
  const tail = lastColon >= 0 ? text.slice(lastColon + 1) : ''
  if (tail.includes('.')) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return null
    const v4 = tail.split('.').map(Number)
    if (v4.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16)
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16)
    text = `${text.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':')
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : null

  const toWords = (groups: string[]): number[] | null => {
    const out: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const headWords = toWords(head)
  if (headWords === null) return null

  let words: number[]
  if (rest === null) {
    // 无 `::`：必须恰好 8 组
    if (headWords.length !== 8) return null
    words = headWords
  } else {
    const restWords = toWords(rest)
    if (restWords === null) return null
    const fill = 8 - headWords.length - restWords.length
    if (fill < 0) return null
    words = [...headWords, ...new Array<number>(fill).fill(0), ...restWords]
  }
  if (words.length !== 8) return null

  const bytes = new Uint8Array(16)
  words.forEach((w, i) => {
    bytes[i * 2] = (w >> 8) & 0xff
    bytes[i * 2 + 1] = w & 0xff
  })
  return bytes
}

/** 16 字节 IPv6 是否属于内网/保留段。 */
function isInternalIpv6(b: Uint8Array): boolean {
  const allZero = b.every(x => x === 0)
  // ::/128 未指定
  if (allZero) return true
  // ::1/128 环回
  if (b.slice(0, 15).every(x => x === 0) && b[15] === 1) return true
  // IPv4 映射 ::ffff:0:0/96 → 取末 4 字节按 IPv4 判定
  if (b.slice(0, 10).every(x => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isInternalIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`)
  }
  // NAT64 64:ff9b::/96 与本地 NAT64 64:ff9b:1::/48 → 末 4 字节按 IPv4 判定
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (b.slice(4, 12).every(x => x === 0) || (b[4] === 0x00 && b[5] === 0x01)) {
      return isInternalIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`)
    }
  }
  // 6to4 2002::/16 → 次 4 字节是内嵌 IPv4
  if (b[0] === 0x20 && b[1] === 0x02) {
    return isInternalIpv4(`${b[2]}.${b[3]}.${b[4]}.${b[5]}`)
  }
  // fc00::/7 ULA
  if ((b[0]! & 0xfe) === 0xfc) return true
  // fe80::/10 链路本地
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true
  // ff00::/8 多播
  if (b[0] === 0xff) return true
  // 2001:db8::/32 文档段
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true
  return false
}

function isInternalIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isFinite(p) || p < 0 || p > 255)) return false
  const [a, b] = parts
  // 127.0.0.0/8 环回
  if (a === 127) return true
  // 10.0.0.0/8 私有
  if (a === 10) return true
  // 172.16.0.0/12 私有
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
  // 192.168.0.0/16 私有
  if (a === 192 && b === 168) return true
  // 169.254.0.0/16 链路本地（云元数据）
  if (a === 169 && b === 254) return true
  // 0.0.0.0
  if (a === 0) return true
  return false
}

/**
 * 由 URI 与可选声明推断展示名（不含路径信息）。
 * @param uri 附件来源地址
 * @param declared 调用方声明的名称（优先）
 * @returns 已净化的文件名（永不为空）
 */
export function attachmentNameFrom(uri: string, declared?: string): string {
  if (declared !== undefined && declared.trim() !== '') return safeAttachmentFileName(declared)
  let leaf = ''
  try {
    leaf = decodeURIComponent(new URL(uri).pathname.split('/').pop() ?? '')
  } catch {
    leaf = uri.split('/').pop() ?? ''
  }
  return safeAttachmentFileName(leaf)
}

/**
 * 净化附件文件名：剥离目录成分与非法字符，规避 Windows 设备名，限制长度。
 * 与 DSH attachment-local 的 fileLeafName 同口径（跨平台引用稳定）。
 * @param name 调用方给出的名称（可能含路径或非法字符）
 * @returns 可安全落盘的文件名（空输入返回 'attachment'）
 */
export function safeAttachmentFileName(name: string): string {
  const leaf = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  let clean = leaf
    // eslint-disable-next-line no-control-regex -- 控制字符必须从文件名中剔除
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(clean)) clean = `_${clean}`
  clean = clean.slice(0, 128).replace(/[. ]+$/u, '')
  return clean === '' || clean === '.' || clean === '..' ? 'attachment' : clean
}

/**
 * 把 workspace 相对路径解析为绝对路径，并拒绝任何越界（`..` / 绝对路径 / 盘符）。
 * @param workspaceDir client 工作目录（绝对路径）
 * @param relPath 账本中的 POSIX 风格相对路径
 * @returns 绝对路径
 * @throws InvalidRequestError 路径越出工作目录
 */
export function resolveWorkspacePath(workspaceDir: string, relPath: string): string {
  const root = resolve(workspaceDir)
  const target = resolve(root, relPath)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(prefix)) {
    throw new InvalidRequestError(`attachment path escapes the client workspace: ${relPath}`)
  }
  return target
}

/** 绝对路径 → workspace 相对的 POSIX 路径（调用方保证 target 在工作目录内）。 */
export function toWorkspaceRelative(workspaceDir: string, absolutePath: string): string {
  const root = resolve(workspaceDir)
  const target = resolve(absolutePath)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(prefix)) {
    throw new InvalidRequestError(`path escapes the client workspace: ${absolutePath}`)
  }
  return target.slice(prefix.length).split(sep).join('/')
}

/** 入站附件的落盘目录（相对 workspace）。 */
export function inboundDirFor(taskId: string): string {
  return `attachments/inbound/${taskId}`
}

/**
 * 拉取全部入站附件并落盘到该 client 的工作目录（§6.4.4）。
 *
 * 逐个串行处理：任一附件失败即整体失败（不写账本、不回滚已落盘文件——它们落在
 * 任务专属目录下，随任务清理策略回收）。总字节上限在执行前预检，避免无谓下载。
 * @param input 附件声明、上限、工作目录与任务 ID
 * @returns 已落盘的入站附件（顺序与声明一致）
 */
export async function prepareInboundAttachments(input: {
  requests: readonly AttachmentRequest[]
  limits: AttachmentLimits
  workspaceDir: string
  taskId: string
  fetch: AttachmentFetcher
}): Promise<PreparedInbound[]> {
  const { requests, limits, workspaceDir, taskId } = input
  if (requests.length === 0) return []
  const dir = join(resolve(workspaceDir), inboundDirFor(taskId))
  await mkdir(dir, { recursive: true })
  const prepared: PreparedInbound[] = []
  let total = 0
  for (const [index, request] of requests.entries()) {
    const fetched = await input.fetch(request.uri, {
      timeoutSeconds: limits.fetchTimeout,
      maxBytes: limits.maxFileBytes,
    })
    // 拉取器可能只按 maxBytes 提前中断读取，这里再独立兜底一次：上限由本层负责。
    if (fetched.data.byteLength > limits.maxFileBytes) {
      throw new InvalidRequestError(
        `attachment exceeds the per-file limit of ${limits.maxFileBytes} bytes: ${request.uri}`,
      )
    }
    total += fetched.data.byteLength
    if (total > limits.maxTotalBytes) {
      throw new InvalidRequestError(
        `attachments exceed the total limit of ${limits.maxTotalBytes} bytes per request`,
      )
    }
    const name = await uniqueName(dir, attachmentNameFrom(request.uri, request.name))
    const mime = resolveAttachmentMime(request, fetched.mime, name, index)
    const absolute = join(dir, name)
    await writeFileAtomically(absolute, fetched.data)
    prepared.push({
      name,
      mime,
      bytes: fetched.data.byteLength,
      relPath: `${inboundDirFor(taskId)}/${name}`,
      sourceUri: request.uri,
    })
  }
  return prepared
}

/** 同目录重名时追加 `-1`、`-2`…（避免后一个附件覆盖前一个）。 */
async function uniqueName(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = name
  for (let n = 1; await exists(join(dir, candidate)); n++) {
    candidate = `${stem}-${n}${ext}`
  }
  return candidate
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 图片必须归一到受支持的媒体类型；文件保留响应头给出的类型（可为 null）。
 * @throws InvalidRequestError 图片类型无法判定或不受支持
 */
function resolveAttachmentMime(
  request: AttachmentRequest,
  responseMime: string | null,
  name: string,
  index: number,
): string | null {
  if (request.type === 'file') return normalizeMime(request.mime) ?? responseMime
  const declared = normalizeMime(request.mime)
  const candidates = [declared, responseMime, imageMediaTypeFromName(name)]
  for (const candidate of candidates) {
    if (isImageMediaType(candidate)) return candidate
  }
  const seen = candidates.filter((candidate): candidate is string => candidate !== null).join(', ')
  throw new InvalidRequestError(
    `attachments[${index}] is declared as an image but its media type is not supported`
    + ` (expected one of ${IMAGE_MEDIA_TYPES.join(', ')}${seen === '' ? '' : `; got ${seen}`})`,
  )
}

/** 原子落盘：先写临时文件再改名，避免半截文件被后续读取。 */
async function writeFileAtomically(path: string, data: Uint8Array): Promise<void> {
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, data)
    await rename(temporary, path)
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/**
 * 组装本轮用户消息的内容块：文本在前，入站附件按账本顺序随后。
 * 每个附件都重新做一次 DSH 附件准入（内容寻址，重复准入幂等）。
 * @param input 文本、入站附件行、工作目录与准入端口
 * @returns DSH 可直接消费的内容块数组
 */
export async function buildUserContent(input: {
  text: string
  rows: readonly TaskAttachmentRow[]
  workspaceDir: string
  admission: AttachmentAdmissionPort
  readFile: (absolutePath: string) => Promise<Uint8Array>
}): Promise<UserContentBlock[]> {
  const content: UserContentBlock[] = [{ type: 'text', text: input.text }]
  for (const row of input.rows) {
    const absolute = resolveWorkspacePath(input.workspaceDir, row.rel_path)
    const data = await input.readFile(absolute)
    if (row.mime !== null && isImageMediaType(row.mime)) {
      const ref = await input.admission.admitImage({ data, mediaType: row.mime, name: row.name })
      content.push({ type: 'image', attachment: ref })
    } else {
      const ref = await input.admission.admitFile({ data, name: row.name })
      content.push({ type: 'file', attachment: ref })
    }
  }
  return content
}

/** 账本行 → 业务方可见的清单条目（不暴露 workspace 路径）。 */
export function toAttachmentEntry(row: TaskAttachmentRow): {
  attachment_id: string
  direction: TaskAttachmentRow['direction']
  name: string
  mime: string | null
  bytes: number
  content_hash: string | null
} {
  return {
    attachment_id: row.id,
    direction: row.direction,
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    content_hash: row.content_hash,
  }
}

/**
 * 真实 HTTP 拉取实现（全局 fetch；跟随重定向，超时与字节上限双重约束）。
 *
 * SSRF 防护：重定向链手动跟踪（最多 maxRedirects 跳），每跳校验目标 host。
 * 读取按流累加：超限立即 abort，不把超大体拉进内存。
 */
export function createHttpAttachmentFetcher(options?: {
  denyInternalHosts?: boolean
  maxRedirects?: number
}): AttachmentFetcher {
  const denyInternal = options?.denyInternalHosts ?? true
  const maxRedirects = options?.maxRedirects ?? 5

  return async (uri, fetchOptions) => {
    let currentUri = uri
    for (let redirects = 0; ; redirects++) {
      if (redirects > maxRedirects) {
        throw new InvalidRequestError(`attachment uri exceeded max redirects (${maxRedirects}): ${uri}`)
      }
      // 每跳都校验目标 host（防止重定向绕过 SSRF 防护）
      if (denyInternal) {
        let parsed: URL
        try { parsed = new URL(currentUri) } catch { throw new InvalidRequestError(`invalid attachment uri: ${currentUri}`) }
        if (isInternalHost(parsed.hostname)) {
          throw new InvalidRequestError(`attachment uri host "${parsed.hostname}" is an internal/private address and is blocked`)
        }
      }
      const response = await fetch(currentUri, {
        method: 'GET',
        redirect: 'manual',  // 手动跟踪重定向，逐跳校验
        signal: AbortSignal.timeout(fetchOptions.timeoutSeconds * 1000),
      })
      // 3xx 重定向：取 Location 继续
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null) throw new InvalidRequestError(`attachment uri returned ${response.status} without Location header: ${currentUri}`)
        // 相对路径 → 绝对路径
        try {
          currentUri = new URL(location, currentUri).href
        } catch {
          throw new InvalidRequestError(`invalid redirect location "${location}" from ${currentUri}`)
        }
        continue
      }
      // 非重定向：正常处理
      if (!response.ok) {
        throw new InvalidRequestError(`attachment uri responded with HTTP ${response.status}: ${currentUri}`)
      }
      const mime = normalizeMime(response.headers.get('content-type'))
      const chunks: Uint8Array[] = []
      let size = 0
      const stream = response.body as unknown as AsyncIterable<Uint8Array> | null
      if (stream !== null) {
        for await (const chunk of stream) {
          size += chunk.byteLength
          if (size > fetchOptions.maxBytes) {
            throw new InvalidRequestError(
              `attachment exceeds the per-file limit of ${fetchOptions.maxBytes} bytes: ${uri}`,
            )
          }
          chunks.push(chunk)
        }
      }
      const data = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { data, mime }
    }
  }
}
