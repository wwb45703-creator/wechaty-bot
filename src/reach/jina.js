/**
 * Jina Reader 后端（https://r.jina.ai/<url>）：把目标页转成干净的 Markdown 文本。
 *
 * ⚠️ 隐私与可用性说明（默认关闭的原因）：
 *  - 第三方服务：目标 URL 会被发送到 r.jina.ai（相当于把链接交给第三方转读）
 *  - 该域名在部分网络环境不可达（实测直连超时），有代理的环境才建议开启
 *  - 开启方式：config.json → reach.jina.enabled = true
 */

import config from '../config-loader.js'
import { logger } from '../logger.js'
import { validateExternalUrl } from '../url-utils.js'

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 返回 {ok, kind:'page', source:'jina', summary} 或 null（未启用/失败，调用方继续下一层） */
export async function fetchViaJina(urlStr, opts = {}) {
  if (config.reach?.jina?.enabled !== true) return null
  const timeoutMs = opts.timeoutMs || 25000
  // 目标 URL 过 SSRF 校验；r.jina.ai 本身是硬编码服务地址，不受聊天内容控制
  const v = await validateExternalUrl(urlStr)
  if (!v.ok) return null

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`https://r.jina.ai/${v.url.href}`, {
      signal: ac.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/plain' },
    })
    if (!res.ok) return null
    const text = (await res.text()).trim()
    if (!text || text.length < 30) return null
    logger.info(`[reach] Jina Reader命中 (${text.length} chars)`)
    return { ok: true, kind: 'page', source: 'jina', summary: text.slice(0, opts.summaryChars || 1200) }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
