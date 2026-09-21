/**
 * dsh-biz-bridge 第一方参考实现 / 开发调试工具 — 共享逻辑。
 *
 * - 验签与请求：按设计签名串 METHOD + pathname + X-Timestamp + X-Nonce +
 *   SHA256(请求体)，RSA-SHA256 私钥签名；实现与插件 auth.ts 口径一致。
 *   附件下载使用 POST 方式（签名与其他 POST 接口一致）。
 * - 附件：清单渲染（renderAttachments）与下载（downloadAttachment：先 fetch 带签名头，
 *   再以 blob URL 触发保存——`<a download>` 无法携带自定义头）。
 * - 密钥策略：私钥只存于页面内存文本框（id: authPrivateKey），本文件不做任何
 *   持久化 —— F5 刷新即丢（安全特性）。
 * - 所有函数挂到 window.Bridge，页面内联脚本通过 Bridge.* 调用。
 */
(function (window, document) {
  'use strict'

  var DEFAULT_BASE_URL = (typeof window !== 'undefined' && window.location)
    ? window.location.origin + '/bizbridge'
    : 'http://127.0.0.1:42731/bizbridge'
  var ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

  function $(id) { return document.getElementById(id) }

  /** 读取全局密钥条（admin/client 页）。字段不存在视为空。 */
  function auth() {
    var read = function (id) { var el = $(id); return el ? el.value : '' }
    return {
      clientId: read('authClientId').trim(),
      privateKey: read('authPrivateKey').trim(),
      baseUrl: (read('authBaseUrl') || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    }
  }

  /** 验签字段校验（已签名页调用）。 */
  function assertAuth() {
    var a = auth()
    if (!a.baseUrl) throw new Error('请填写 Base URL')
    if (!ID_PATTERN.test(a.clientId)) throw new Error('Client-Id 需匹配 1-128 位字母 / 数字 / _ / -')
    if (!/BEGIN PRIVATE KEY/.test(a.privateKey)) throw new Error('请粘贴 PKCS#8 私钥（-----BEGIN PRIVATE KEY-----…）')
    return a
  }

  function bytesToBase64(bytes) {
    var binary = ''
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }

  function base64ToBytes(b64) {
    var binary = atob(b64)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  function pemToArrayBuffer(pem) {
    var b64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '')
    return base64ToBytes(b64).buffer
  }

  function pemWrap(base64, label) {
    var lines = base64.match(/.{1,64}/g) || [base64]
    return '-----BEGIN ' + label + '-----\n' + lines.join('\n') + '\n-----END ' + label + '-----'
  }

  async function sha256Hex(text) {
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    var hex = ''
    new Uint8Array(digest).forEach(function (b) { hex += b.toString(16).padStart(2, '0') })
    return hex
  }

  /** 构造签名头（X-Signature = base64(RSA-SHA256 私钥, 签名串)）。 */
  async function makeHeaders(method, path, bodyObj) {
    var a = assertAuth()
    var raw = bodyObj === undefined || bodyObj === null ? '' : JSON.stringify(bodyObj)
    var timestamp = String(Math.floor(Date.now() / 1000))
    var nonce = crypto.randomUUID()
    var digestHex = await sha256Hex(raw)
    var signString = method + path + timestamp + nonce + digestHex
    var key = await crypto.subtle.importKey(
      'pkcs8', pemToArrayBuffer(a.privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    var signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signString))
    return {
      'Content-Type': 'application/json',
      'X-Client-Id': a.clientId,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Signature': bytesToBase64(new Uint8Array(signature)),
    }
  }

  /** 从 baseUrl + path 提取完整 pathname（用于签名串）。 */
  function fullPathname(baseUrl, path) {
    try {
      var base = new URL(baseUrl)
      // path 以 / 开头时 new URL 会覆盖而非拼接，需手动拼接 base.pathname
      return path.charAt(0) === '/' ? base.pathname.replace(/\/$/, '') + path : path
    } catch { return path }
  }

  /** 常规 JSON 请求：返回 { httpStatus, ok, data, text }（不抛业务错误）。 */
  async function request(path, bodyObj) {
    var a = assertAuth()
    var headers = await makeHeaders('POST', fullPathname(a.baseUrl, path), bodyObj)
    var response = await fetch(a.baseUrl + path, {
      method: 'POST',
      headers: headers,
      body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
    })
    var text = await response.text()
    var data = null
    try { data = text === '' ? null : JSON.parse(text) } catch (e) { /* 非 JSON */ }
    return { httpStatus: response.status, ok: response.ok, data: data, text: text }
  }

  /**
   * SSE（POST）：fetch + 逐帧解析。插件流式接口必须 POST，故不能用 EventSource。
   * handlers.onFrame(frame) 收到每条 data: 的 JSON；handlers.onError(err)。
   * 返回 { close } 供页面中断（断连即取消由插件端执行）。
   */
  function sseOpen(path, bodyObj, handlers) {
    var a = assertAuth()
    var controller = new AbortController()
    var closed = false

    function parseBlock(block, onFrame) {
      var lines = block.split('\n')
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i]
        if (line.indexOf('data:') !== 0) continue // ': ping' 等注释行忽略
        var payload = line.slice(5).trim()
        if (payload === '') continue
        var frame = null
        try { frame = JSON.parse(payload) } catch (e) { onFrame({ event: 'sse-error', message: '非 JSON 帧: ' + payload }); continue }
        onFrame(frame)
      }
    }

    (async function () {
      var response = null
      try {
        response = await fetch(a.baseUrl + path, {
          method: 'POST',
          headers: await makeHeaders('POST', fullPathname(a.baseUrl, path), bodyObj),
          body: JSON.stringify(bodyObj),
          signal: controller.signal,
        })
      } catch (e) {
        if (!closed && handlers.onError) handlers.onError(e)
        return
      }
      if (!response.ok || !response.body) {
        var text = ''
        try { text = await response.text() } catch (e) { /* ignore */ }
        if (handlers.onError) handlers.onError(new Error('HTTP ' + response.status + (text ? ': ' + text.slice(0, 300) : '')))
        return
      }
      var reader = response.body.getReader()
      var decoder = new TextDecoder()
      var buffer = ''
      try {
        for (;;) {
          var step = await reader.read()
          if (step.done) break
          buffer += decoder.decode(step.value, { stream: true })
          var idx
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            var block = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            parseBlock(block, function (frame) { if (handlers.onFrame) handlers.onFrame(frame) })
          }
        }
        if (buffer !== '') parseBlock(buffer, function (frame) { if (handlers.onFrame) handlers.onFrame(frame) })
      } catch (e) {
        if (!closed && handlers.onError) handlers.onError(e)
      }
    })()

    return {
      close: function () {
        closed = true
        try { controller.abort() } catch (e) { /* ignore */ }
      },
    }
  }

  /** 生成 RSA-2048 签名密钥对（utils 页）。 */
  async function makeKeyPair() {
    var pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['sign', 'verify'])
    var publicKey = await crypto.subtle.exportKey('spki', pair.publicKey)
    var privateKey = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
    return {
      publicPem: pemWrap(bytesToBase64(new Uint8Array(publicKey)), 'PUBLIC KEY'),
      privatePem: pemWrap(bytesToBase64(new Uint8Array(privateKey)), 'PRIVATE KEY'),
    }
  }

  function fmtJson(value) {
    try {
      return JSON.stringify(value, null, 2)
    } catch (e) {
      return String(value)
    }
  }

  function escHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  /** 人类可读字节数（B / KiB / MiB）。 */
  function formatBytes(n) {
    var value = Number(n)
    if (!isFinite(value) || value < 0) return '—'
    if (value < 1024) return value + ' B'
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB'
    return (value / (1024 * 1024)).toFixed(2) + ' MiB'
  }

  /**
   * 取附件字节：POST /api/v1/attachments/download（推荐方式，签名与其他 POST 接口一致）。
   * @param {string} attachmentId 清单里的 attachment_id
   * @param {string} [fallbackName] 响应头无文件名时的兜底名字
   * @returns {Promise<{blob: Blob, filename: string, contentType: string, bytes: number}>}
   */
  async function fetchAttachment(attachmentId, fallbackName) {
    var a = assertAuth()
    var path = '/api/v1/attachments/download'
    var bodyObj = { attachment_id: attachmentId }
    var headers = await makeHeaders('POST', fullPathname(a.baseUrl, path), bodyObj)
    var response = await fetch(a.baseUrl + path, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(bodyObj),
    })
    if (!response.ok) {
      var text = ''
      try { text = await response.text() } catch (e) { /* 错误体不可读时只报状态码 */ }
      throw new Error('HTTP ' + response.status + (text ? ': ' + text.slice(0, 200) : ''))
    }
    var blob = await response.blob()
    var filename = fallbackName || 'attachment'
    var disposition = response.headers.get('content-disposition') || ''
    var encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
    if (encoded) { try { filename = decodeURIComponent(encoded[1]) } catch (e) { /* 保留兜底名 */ } }
    return {
      blob: blob,
      filename: filename,
      contentType: response.headers.get('content-type') || blob.type || 'application/octet-stream',
      bytes: blob.size,
    }
  }

  /** 下载附件到本地：签名头无法挂在 <a download> 上，故先 fetch 再 blob URL。 */
  async function downloadAttachment(attachmentId, fallbackName) {
    var got = await fetchAttachment(attachmentId, fallbackName)
    var url = URL.createObjectURL(got.blob)
    var link = document.createElement('a')
    link.href = url
    link.download = got.filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    setTimeout(function () { URL.revokeObjectURL(url) }, 10000)
    return got
  }

  /**
   * 渲染附件清单（含下载按钮）。
   * 事件用 container.onclick 赋值，重复渲染不会叠加监听。
   * @param {Element} container 容器元素
   * @param {Array} list 条目 [{attachment_id, direction, name, mime, bytes}]
   * @param {string} [emptyText] 空清单文案
   */
  function renderAttachments(container, list, emptyText) {
    if (!container) return
    var items = list || []
    if (!items.length) {
      container.innerHTML = '<div class="msg">' + escHtml(emptyText || '（无附件）') + '</div>'
      container.onclick = null
      return
    }
    container.innerHTML = items.map(function (item) {
      var inbound = item.direction === 'inbound'
      return '<div class="att-item">' +
        '<span class="att-dir ' + (inbound ? 'inbound' : 'outbound') + '">' + (inbound ? '入站' : '出站') + '</span>' +
        '<span class="att-name" title="' + escHtml(item.name) + '">' + escHtml(item.name) + '</span>' +
        '<span class="att-meta">' + escHtml(item.mime || '类型未知') + ' · ' + formatBytes(item.bytes) + '</span>' +
        '<button class="small" type="button" data-att-id="' + escHtml(item.attachment_id) + '"' +
        ' data-att-name="' + escHtml(item.name) + '">下载</button>' +
        '</div>'
    }).join('')
    container.onclick = function (ev) {
      var button = ev.target.closest ? ev.target.closest('button[data-att-id]') : null
      if (!button) return
      button.disabled = true
      downloadAttachment(button.getAttribute('data-att-id'), button.getAttribute('data-att-name'))
        .then(function () { button.disabled = false })
        .catch(function (e) {
          button.disabled = false
          alert('附件下载失败：' + e.message)
        })
    }
  }

  /** 渲染一次请求结果（ok 绿框 / 错误红框）。 */
  function showResult(el, result) {
    el.className = result.ok ? 'view ok' : 'view err'
    if (result.ok) {
      el.textContent = 'HTTP ' + result.httpStatus + '\n' + fmtJson(result.data)
    } else {
      var detail = result.data && result.data.error
        ? 'HTTP ' + result.httpStatus + ' [' + detail.code + '] ' + detail.message
        : 'HTTP ' + result.httpStatus + (result.text ? '\n' + result.text : '')
      el.textContent = detail + (result.data ? '\n' + fmtJson(result.data) : '')
    }
  }

  function showMsg(el, text, kind) {
    el.textContent = text
    el.className = 'msg' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '')
  }

  function copyText(text) {
    if (!text) return Promise.resolve(false)
    function legacy() {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      var ok = false
      try { ok = document.execCommand('copy') } catch (e) { ok = false }
      document.body.removeChild(ta)
      return ok
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true }, legacy)
    }
    return Promise.resolve(legacy())
  }

  /** 顶部导航高亮（页面 body[data-page]）。 */
  function initNav() {
    var page = document.body.getAttribute('data-page')
    var links = document.querySelectorAll('nav.main a')
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('href') && page && links[i].getAttribute('href').indexOf(page + '.html') >= 0) {
        links[i].classList.add('active')
      }
    }
  }

  /**
   * 侧栏显隐切换（sidebar + section 面板联动）。
   * @param {string} sidebarSelector  侧栏容器选择器（默认 '.sidebar'）
   * @param {string} sectionSelector  内容区面板选择器（默认 '.content > section.panel'）
   */
  function initSidebar(sidebarSelector, sectionSelector) {
    var sidebar = document.querySelector(sidebarSelector || '.sidebar')
    if (!sidebar) return
    var links = sidebar.querySelectorAll('a[href^="#"]')
    var sections = document.querySelectorAll(sectionSelector || '.content > section.panel')
    if (!links.length || !sections.length) return

    // 隐藏所有面板，显示第一个
    function showSection(id) {
      for (var i = 0; i < sections.length; i++) {
        sections[i].style.display = sections[i].id === id ? '' : 'none'
      }
      for (var j = 0; j < links.length; j++) {
        links[j].classList.toggle('active', links[j].getAttribute('href') === '#' + id)
      }
    }

    // 默认显示第一个
    var firstId = links[0].getAttribute('href').slice(1)
    showSection(firstId)

    // 点击切换
    sidebar.addEventListener('click', function (ev) {
      var link = ev.target.closest ? ev.target.closest('a[href^="#"]') : null
      if (!link) return
      ev.preventDefault()
      showSection(link.getAttribute('href').slice(1))
    })
  }

  window.Bridge = {
    DEFAULT_BASE_URL: DEFAULT_BASE_URL,
    ID_PATTERN: ID_PATTERN,
    $: $,
    auth: auth,
    assertAuth: assertAuth,
    makeHeaders: makeHeaders,
    request: request,
    sseOpen: sseOpen,
    makeKeyPair: makeKeyPair,
    fmtJson: fmtJson,
    formatBytes: formatBytes,
    fetchAttachment: fetchAttachment,
    downloadAttachment: downloadAttachment,
    renderAttachments: renderAttachments,
    showResult: showResult,
    showMsg: showMsg,
    copyText: copyText,
    pemWrap: pemWrap,
    initNav: initNav,
    initSidebar: initSidebar,
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav)
  } else {
    initNav()
  }
})(window, document)
