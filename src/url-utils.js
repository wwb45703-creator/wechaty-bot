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

export function extractPublication(html) {
  let value
  for (const tag of String(html).match(/<meta\b[^>]*>/gi) || []) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(match => [match[1].toLowerCase(), match[2]]))
    if (/^(?:article:published_time|datePublished|publishdate|pubdate)$/i.test(attributes.property || attributes.name || attributes.itemprop || '')) { value = attributes.content; break }
  }
  value ||= (String(html).match(/"datePublished"\s*:\s*"([^"']+)"/i) || [])[1]
    || (String(html).match(/<time[^>]*datetime=["']([^"']+)["']/i) || [])[1]
    || (htmlToText(html).slice(0, 700).match(/(?:发布时间|发布日期|发表时间|发布时间[:：]?|时间[:：])\s*[:：]?\s*(\d{4}[-年/]\d{1,2}[-月/]\d{1,2}日?)/) || [])[1]
  const normalized = value?.replace(/年|月/g, '-').replace(/日/g, '').replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (_, y, m, d) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
  const parsed = normalized && new Date(normalized)
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
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
    const publishedAt = extractPublication(raw)
    const text = htmlToText(raw).slice(0, Math.min(12000, opts.summaryChars || 1200))
    if (!title && !description && !text) return { ok: false, error: '页面没有可读的文本内容' }
    const summary = [title && `标题：${title}`, description && `简介：${description}`, text && `正文摘录：${text}`].filter(Boolean).join('\n')
    return { ok: true, kind: 'page', title, description, text, summary, publishedAt, url: response.url || urlStr, truncated: response.truncated || false }
  } catch (err) {
    return { ok: false, error: err.fatal ? err.message : '链接无法访问', code: err.code || 'FETCH_FAILED', fatal: Boolean(err.fatal) }
  }
}
