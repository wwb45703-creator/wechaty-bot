import { externalFetch } from './external-http.js'
export { validateExternalUrl, isPrivateIp } from './external-http.js'

export function extractFirstUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"'，。；！？、）】》]+/i)
  if (!m) return null
  // 去掉末尾可能被误包含的英文标点（如句末的 . ? ! , ) ]）
  return m[0].replace(/[,.!?:;)\]]+$/, '')
}

export function htmlToText(html) {
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

/** 提取 <title> 与常用 meta 描述（reach/browser 层也复用） */
export function extractMeta(html) {
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

/** Public-page reader. DNS, redirects and the complete body share one bounded request. */
export async function fetchPageText(urlStr, opts = {}) {
  try {
    const response = await (opts.client || externalFetch)(urlStr, opts)
    if (!response.ok) return { ok: false, error: `链接返回 HTTP ${response.status}` }
    const contentType = response.headers.get('content-type') || ''
    const media = isMediaDirect(contentType, new URL(response.url || urlStr).pathname)
    if (media) return { ok: true, kind: 'media', summary: `这是一个${media}直链，无法直接读取其内容。` }
    const raw = await response.text()
    const { title, description } = extractMeta(raw)
    const text = htmlToText(raw).slice(0, Math.min(12000, opts.summaryChars || 1200))
    if (!title && !description && !text) return { ok: false, error: '页面没有可读的文本内容' }
    const summary = [title && `标题：${title}`, description && `简介：${description}`, text && `正文摘录：${text}`].filter(Boolean).join('\n')
    return { ok: true, kind: 'page', title, description, text, summary, truncated: response.truncated || false }
  } catch (err) {
    return { ok: false, error: err.fatal ? err.message : '链接无法访问', code: err.code || 'FETCH_FAILED', fatal: Boolean(err.fatal) }
  }
}
