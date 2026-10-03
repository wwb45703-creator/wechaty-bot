/**
 * 搜索后端：必应(cn.bing.com) 结果页抓取（零 key、零外部依赖、国内直连可达）。
 *
 * 实测依据（2026-10）：
 *  - cn.bing.com 免 key 可达，结果页 HTML 结构稳定（li.b_algo 块），已验证解析
 *  - Exa 免费额度有限流（实测触发），且走子进程 DSL 有注入面，暂不采用；
 *    有付费 key 后可直连 Exa HTTP API（POST api.exa.ai/search）再扩展此模块
 *  - r.jina.ai / DuckDuckGo / Google 在当前网络不可达，不采用
 *
 * 安全约定：搜索词来自聊天内容，仅经 encodeURIComponent 进入硬编码域名的查询串，
 * 不经过任何子进程；sanitizeQuery 兜底清洗控制字符与超长输入。
 */

import config from '../config-loader.js'
import { logger } from '../logger.js'

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 清洗聊天内容来的搜索词：去控制字符/引号类符号，限长 100 */
export function sanitizeQuery(raw) {
  return String(raw || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["'`\\<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
}

/** HTML 实体解码（覆盖必应摘要里常见的少量实体） */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&ensp;|&emsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/** 必应跳转链接（/ck/a?...u=a1<base64url>）还原真实地址 */
function unwrapBingUrl(href) {
  try {
    const u = new URL(href, 'https://cn.bing.com')
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const raw = u.searchParams.get('u') || ''
      const b64 = raw.replace(/^a1/, '')
      if (b64 && /^[A-Za-z0-9_-]+$/.test(b64)) {
        const decoded = Buffer.from(b64, 'base64url').toString('utf8')
        if (/^https?:\/\//.test(decoded)) return decoded
      }
      return ''
    }
    return u.href
  } catch {
    return href
  }
}

/**
 * 必应搜索。
 * @returns {Promise<Array<{title,url,snippet}>|null>} 无结果/网络失败返回 null
 */
export async function bingSearch(query, opts = {}) {
  const num = opts.numResults || 6
  const timeoutMs = opts.timeoutMs || 15000
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=10&setlang=zh-CN`
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    })
    if (!res.ok) {
      logger.warn(`[reach] 必应搜索 HTTP ${res.status}`)
      return null
    }
    const html = await res.text()
    const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || []
    const results = []
    const seen = new Set()
    for (const b of blocks) {
      const t = b.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i)
      if (!t) continue
      const link = unwrapBingUrl(t[1])
      if (!link || !/^https?:\/\//.test(link) || seen.has(link)) continue
      seen.add(link)
      const snip = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      results.push({ title: stripTags(t[2]), url: link, snippet: snip ? stripTags(snip[1]).slice(0, 200) : '' })
      if (results.length >= num) break
    }
    if (!results.length) return null
    return results
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 搜索主入口。engine 预留扩展（当前仅 bing）。
 * @returns {Promise<{engine: string, results: Array}|null>}
 */
export async function webSearch(query, opts = {}) {
  const safeQuery = sanitizeQuery(query)
  if (!safeQuery) return null
  const results = await bingSearch(safeQuery, opts)
  if (results && results.length) {
    logger.info(`[reach] 搜索命中(bing): "${safeQuery.slice(0, 40)}" ${results.length} 条`)
    return { engine: 'bing', results }
  }
  logger.warn(`[reach] 搜索无结果: "${safeQuery.slice(0, 40)}"`)
  return null
}
