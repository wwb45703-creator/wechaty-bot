import dns from 'node:dns'
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'

function blocked(message, code = 'BLOCKED_URL') {
  return Object.assign(new Error(message), { code, fatal: true })
}

export function isPrivateIp(value) {
  const ip = String(value || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  const family = net.isIP(ip)
  if (family === 4) {
    const [a, b, c] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
  }
  if (family !== 6) return true
  let expanded = ip
  if (ip.includes('.')) {
    const tail = ip.slice(ip.lastIndexOf(':') + 1).split('.').map(Number)
    expanded = ip.slice(0, ip.lastIndexOf(':') + 1) + ((tail[0] << 8) | tail[1]).toString(16) + ':' + ((tail[2] << 8) | tail[3]).toString(16)
  }
  const halves = expanded.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const words = (halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left).map(x => parseInt(x || '0', 16))
  if (words.slice(0, 5).every(x => x === 0) && words[5] === 0xffff) {
    return isPrivateIp(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`)
  }
  // Only global unicast; exclude documentation, special-purpose and 6to4 tunnels.
  return words[0] < 0x2000 || words[0] > 0x3fff || words[0] === 0x2002 ||
    (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) ||
    (words[0] === 0x3fff && words[1] < 0x1000)
}

function abortable(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(blocked('外部请求已取消或超时', 'CANCELLED'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(blocked('外部请求已取消或超时', 'CANCELLED'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export async function validateExternalUrl(raw, { lookup = dns.promises.lookup, signal } = {}) {
  try {
    let url
    try { url = new URL(raw) } catch { throw blocked('不是合法的链接') }
    if (!['http:', 'https:'].includes(url.protocol)) throw blocked('仅支持 http/https 链接')
    if (url.username || url.password) throw blocked('链接不允许包含凭据')
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === 'localhost' || /\.(localhost|local|lan|internal)$/.test(host) || !host || host.includes('%')) {
      throw blocked('该链接指向内网/本机地址，已拒绝访问')
    }
    const family = net.isIP(host)
    const addresses = family ? [{ address: host, family }] : await abortable(lookup(host, { all: true, verbatim: true }), signal)
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(x => isPrivateIp(x.address))) {
      throw blocked('该链接指向私有、保留或本机地址，已拒绝访问')
    }
    return { ok: true, url, addresses }
  } catch (error) {
    return { ok: false, error: error.code === 'BLOCKED_URL' || error.code === 'CANCELLED' ? error.message : '域名无法安全解析',
      code: error.code === 'CANCELLED' ? 'CANCELLED' : 'BLOCKED_URL', fatal: true }
  }
}

function requestPinned(url, { addresses, signal, headers, maxBytes }) {
  return new Promise((resolve, reject) => {
    const selected = addresses[0]
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal, agent: false, maxHeaderSize: 16384,
      headers: { 'User-Agent': 'WechatyBot/2.0', 'Accept-Encoding': 'identity', ...headers },
      // Connect to the checked address, retaining the original host for TLS verification.
      lookup: (_host, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {} }
        if (options?.all) callback(null, addresses)
        else callback(null, selected.address, selected.family)
      },
    }, response => {
      const chunks = []
      let size = 0
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        resolve({ status: response.statusCode || 502, headers: response.headers, body: Buffer.concat(chunks), truncated: size >= maxBytes })
      }
      response.on('data', chunk => {
        const bytes = Buffer.from(chunk).subarray(0, maxBytes - size)
        chunks.push(bytes)
        size += bytes.length
        if (size >= maxBytes) { finish(); response.destroy() }
      })
      response.on('end', finish)
      response.on('error', error => { if (!finished) reject(error) })
      response.on('aborted', () => { if (!finished) reject(new Error('响应体提前中断')) })
    })
    request.on('error', reject)
    request.end()
  })
}

/** A bounded, DNS-pinned HTTP client; dependencies are injectable only by local code/tests. */
export function createExternalClient({ lookup = dns.promises.lookup, request = requestPinned } = {}) {
  return async function externalFetch(raw, options = {}) {
    if (process.env.BOT_OFFLINE === '1' && request === requestPinned) throw blocked('离线验收禁止真实网络请求', 'OFFLINE')
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (options.signal?.aborted) onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const remaining = options.deadline ? options.deadline - Date.now() : Infinity
    const timeout = Math.max(1, Math.min(options.timeoutMs || 20000, remaining))
    const timer = setTimeout(onAbort, timeout)
    const maxBytes = Math.min(400000, Math.max(1, options.maxBytes || 400000))
    let current = raw
    try {
      for (let hop = 0; hop < 5; hop++) {
        const checked = await validateExternalUrl(current, { lookup, signal: controller.signal })
        if (!checked.ok) throw blocked(checked.error, checked.code)
        const result = await abortable(request(checked.url, { addresses: checked.addresses,
          signal: controller.signal, maxBytes, headers: options.headers || {} }), controller.signal)
        const headers = new Headers()
        for (const [key, value] of Object.entries(result.headers || {})) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : String(value))
        }
        if (result.status >= 300 && result.status < 400 && headers.get('location') && options.redirect !== 'manual') {
          if (hop === 4) throw blocked('重定向次数过多')
          current = new URL(headers.get('location'), checked.url).href
          continue
        }
        const body = [204, 205, 304].includes(result.status) ? null : Buffer.from(result.body || '').subarray(0, maxBytes)
        const response = new Response(body, { status: result.status, headers })
        Object.defineProperty(response, 'url', { value: checked.url.href })
        Object.defineProperty(response, 'truncated', { value: Boolean(result.truncated) })
        return response
      }
      throw blocked('重定向次数过多')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

export const externalFetch = createExternalClient()
