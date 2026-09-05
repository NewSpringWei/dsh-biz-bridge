/**
 * dsh-biz-bridge 第一方参考实现 / 开发调试工具 — 共享逻辑。
 *
 * - 验签与请求：按设计签名串 METHOD + pathname + X-Timestamp + X-Nonce +
 *   SHA256(请求体)，RSA-SHA256 私钥签名；实现与插件 auth.ts 口径一致。
 * - 密钥策略：私钥只存于页面内存文本框（id: authPrivateKey），本文件不做任何
 *   持久化 —— F5 刷新即丢（安全特性）。
 * - 所有函数挂到 window.Bridge，页面内联脚本通过 Bridge.* 调用。
 */
(function (window, document) {
  'use strict'

  var DEFAULT_BASE_URL = 'http://127.0.0.1:3080/bizbridge'
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

  /** 常规 JSON 请求：返回 { httpStatus, ok, data, text }（不抛业务错误）。 */
  async function request(path, bodyObj) {
    var a = assertAuth()
    var headers = await makeHeaders('POST', path, bodyObj)
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
          headers: await makeHeaders('POST', path, bodyObj),
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
    showResult: showResult,
    showMsg: showMsg,
    copyText: copyText,
    pemWrap: pemWrap,
    initNav: initNav,
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav)
  } else {
    initNav()
  }
})(window, document)
