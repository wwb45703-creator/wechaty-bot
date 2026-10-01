/**
 * 链接识别工具：提取 URL、SSRF 防护校验、抓取网页文本
 *
 * 安全约定（必须维持）：
 *  - 仅允许 http/https 协议
 *  - 拒绝 localhost / 环回 / 私有 / 保留地址（含 DNS 解析后的 IP，防内网探测）
 *  - 重定向逐跳校验（最多 4 跳）
 *  - 响应体流式读取、超过 maxBytes 截断（防超大文件拖垮内存）
 */

import dns from 'node:dns'
import { logger } from './logger.js'

/** 从文本中提取第一个 http(s) 链接（排除中文标点结尾） */
export function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"'，。；！？、）】》]+/i)
  return m ? m[0] : null
}

/** IPv4/IPv6 是否属于私有/保留网段 */
export function isPrivateIp(ip) {
  if (!ip) return true
  const s = String(ip).toLowerCase()
  if (s === '::1' || s === '::' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true // 环回/未指定/链路本地/ULA
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7)) // IPv4-mapped
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 0 || a === 10 || a === 127) return true // 0.0.0.0/8、10/8、环回
    if (a === 169 && b === 254) return true            // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true   // 172.16/12
    if (a === 192 && b === 168) return true            // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true  // CGNAT
    if (a >= 224) return true                          // 组播/保留
  }
  return false
}

/** 主机名是否明显内网（未经 DNS 的快速判断） */
function isSuspiciousHost(hostname) {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true
  if (isPrivateIp(h)) return true // 裸 IP 直接判断
  return false
}

/**
 * 校验 URL 可安全抓取。
 * 返回 { ok: true, url: URL } 或 { ok: false, error }。
 */
export async function validateExternalUrl(urlStr) {
  let url
  try {
    url = new URL(urlStr)
  } catch {
    return { ok: false, error: '不是合法的链接' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http/https 链接' }
  }
  if (isSuspiciousHost(url.hostname)) {
    return { ok: false, error: '该链接指向内网/本机地址，已拒绝访问' }
  }
  // DNS 解析后复核（防止域名解析到内网 IP 的探测）
  try {
    const rec = await dns.promises.lookup(url.hostname, { all: true })
    if (!rec || !rec.length) return { ok: false, error: '域名无法解析' }
    if (rec.some((r) => isPrivateIp(r.address))) {
      return { ok: false, error: '该链接指向内网/本机地址，已拒绝访问' }
    }
  } catch (err) {
    return { ok: false, error: '域名无法解析：' + err.message }
  }
  return { ok: true, url }
}

/** 去掉 HTML 标签/脚本，压缩空白，提取可读文本 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 提取 <title> 与常用 meta 描述 */
function extractMeta(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]
  const desc =
    (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i) || [])[1] ||
    (html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i) || [])[1] ||
    (html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || [])[1]
  const clean = (s) => (s ? htmlToText(s).slice(0, 300) : '')
  return { title: clean(title), description: clean(desc) }
}

/** 判断 Content-Type / 路径是否为视频/音频/图片等媒体直链 */
function isMediaDirect(type, urlPath) {
  if (/^video\//i.test(type)) return '视频文件'
  if (/^audio\//i.test(type)) return '音频文件'
  if (/^image\//i.test(type)) return '图片文件'
  if (/\.(mp4|mkv|avi|mov|flv|wmv|webm|m4v)(\?|$)/i.test(urlPath)) return '视频文件'
  if (/\.(mp3|wav|flac|m4a)(\?|$)/i.test(urlPath)) return '音频文件'
  return null
}

/**
 * 抓取 URL 并提取可读文本摘要。
 * 返回 { ok: true, kind: 'page'|'media', summary } 或 { ok: false, error }。
 * summary 是给 AI 看的内容素材（标题/描述/正文摘录）。
 */
export async function fetchPageText(urlStr, opts) {
  const o = opts || {}
  const timeoutMs = o.timeoutMs || 20000
  const maxBytes = o.maxBytes || 400000
  const summaryChars = o.summaryChars || 1200

  // 校验（含 DNS 复核）
  const v = await validateExternalUrl(urlStr)
  if (!v.ok) return { ok: false, error: v.error }
  let current = v.url.href

  // 逐跳跟随重定向（每跳都重新校验目标，最多 4 跳）
  let response = null
  let redirectExhausted = false
  for (let hop = 0; hop < 4; hop++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      })
    } catch (err) {
      clearTimeout(timer)
      return { ok: false, error: '链接无法访问（超时或被拒绝）' }
    }
    clearTimeout(timer)

    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location')
      if (!loc) break
      current = new URL(loc, current).href
      const nv = await validateExternalUrl(current)
      if (!nv.ok) return { ok: false, error: nv.error }
      continue
    }
    break
  }

  if (!response) return { ok: false, error: '链接无法访问' }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, error: '重定向次数过多' }
  }
  if (response.status >= 400) {
    return { ok: false, error: '链接返回了错误状态 ' + response.status + '（页面可能已删除或需要登录）' }
  }

  const contentType = response.headers.get('content-type') || ''
  const urlPath = new URL(current).pathname
  const media = isMediaDirect(contentType, urlPath)
  if (media) {
    return { ok: true, kind: 'media', summary: `这是一个${media}直链（类型 ${contentType.split(';')[0]}），无法直接读取其内容。` }
  }

  // 流式读取正文，超限截断
  const chunks = []
  let total = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      total += value.length
      if (total >= maxBytes) break
    }
  } catch (err) {
    if (total === 0) return { ok: false, error: '读取链接内容失败：' + err.message }
    // 已读到部分内容则继续解析
  }

  if (/^video\//i.test(contentType)) return { ok: true, kind: 'media', summary: '这是一个视频内容，无法直接读取。' }

  const raw = Buffer.concat(chunks).toString('utf8')
  const { title, description } = extractMeta(raw)
  const bodyText = htmlToText(raw).slice(0, summaryChars)

  if (!title && !description && !bodyText) {
    return { ok: false, error: '页面没有可读的文本内容' }
  }

  let summary = ''
  if (title) summary += `标题：${title}\n`
  if (description) summary += `简介：${description}\n`
  if (bodyText) summary += `正文摘录：${bodyText}`
  logger.info(`[链接] 抓取成功 ${current.slice(0, 80)} (${total} bytes)`)
  return { ok: true, kind: 'page', summary: summary.trim() }
}
