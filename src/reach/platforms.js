/**
 * L0 平台特化路由：按硬编码域名白名单分流到各平台最优接入方式
 * （Agent-Reach 的路由思想落地：B站/YouTube/抖音走 yt-dlp 或官方 API、
 *  V2EX/GitHub 走公开 API / gh CLI）。
 *
 * 安全约定：
 *  - 只匹配下方白名单域名，聊天内容无法注入其他目标
 *  - 每个目标 URL 都先过 validateExternalUrl（SSRF 防护）
 *  - 适配器失败一律返回 null，静默落入 L1 通用抓取链
 */

import config from '../config-loader.js'
import { logger } from '../logger.js'
import { validateExternalUrl } from '../url-utils.js'
import { runCli, hasCli } from './spawn-utils.js'

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** 域名 → 平台 key（后缀匹配，带点防前缀误伤） */
const DOMAIN_TABLE = [
  ['bilibili', ['.bilibili.com', '.b23.tv']],
  ['youtube', ['.youtube.com', '.youtu.be']],
  ['douyin', ['.douyin.com', '.iesdouyin.com']],
  ['v2ex', ['.v2ex.com']],
  ['github', ['.github.com']],
]

export function matchPlatform(hostname) {
  const h = String(hostname || '').toLowerCase()
  for (const [key, suffixes] of DOMAIN_TABLE) {
    if (suffixes.some((s) => h === s.slice(1) || h.endsWith(s))) return key
  }
  return null
}

/** 平台链接的统一返回格式，kind=video 时 on-link 用"总结视频"prompt */
function videoResult(platform, summary, extra = {}) {
  return { ok: true, kind: 'video', source: platform, summary, ...extra }
}

/** 跟随短链重定向拿到真实 URL（每跳重新校验，最多 3 跳） */
async function resolveRedirects(urlStr, timeoutMs) {
  let current = urlStr
  for (let hop = 0; hop < 3; hop++) {
    const v = await validateExternalUrl(current)
    if (!v.ok) return null
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await fetch(current, { redirect: 'manual', signal: ac.signal, headers: { 'User-Agent': BROWSER_UA } })
    } catch {
      clearTimeout(timer)
      return null
    }
    clearTimeout(timer)
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href
      continue
    }
    return current
  }
  return null
}

/** 提取 bvid（/video/BVxx 或 BVxx 开头的路径段） */
function extractBvid(pathname) {
  const m = pathname.match(/BV[0-9A-Za-z]{8,}/i)
  return m ? m[0] : null
}

/**
 * B站：官方 view API（实测免登录可用；yt-dlp 会被 412 风控拦截）。
 * AI 字幕需登录态，此处取标题/UP主/简介作素材。
 */
async function fetchBilibili(url, timeoutMs) {
  // b23.tv 短链先解析成视频页
  let target = url.href
  if (url.hostname.endsWith('b23.tv')) {
    const resolved = await resolveRedirects(target, Math.min(timeoutMs, 10000))
    if (!resolved) return null
    target = resolved
  }
  const bvid = extractBvid(new URL(target).pathname)
  if (!bvid) return null
  const v = await validateExternalUrl('https://api.bilibili.com/x/web-interface/view')
  if (!v.ok) return null
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.min(timeoutMs, 12000))
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      signal: ac.signal,
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.bilibili.com/' },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data?.code !== 0 || !data.data) return null
    const info = data.data
    const parts = [`标题：${info.title}`, `UP主：${info.owner?.name || '未知'}`]
    if (info.duration) parts.push(`时长：约 ${Math.round(info.duration / 60)} 分钟`)
    if (info.desc) parts.push(`简介：${String(info.desc).slice(0, 600)}`)
    if ((info.pages || []).length > 1) parts.push(`（共 ${info.pages.length} 个分P）`)
    logger.info(`[reach] B站API命中: ${bvid}`)
    return videoResult('bilibili', parts.join('\n'))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** YouTube/抖音：yt-dlp 尝试（有代理/有效 cookies 时可用；失败自动落入通用链） */
async function fetchViaYtDlp(url, timeoutMs) {
  if (!(await hasCli('yt-dlp'))) return null
  // 只输出需要的字段，避免 -J 的整页 JSON
  const meta = await runCli(
    'yt-dlp',
    [
      '--no-playlist', '--skip-download', '--no-warnings', '--socket-timeout', '15',
      '--print', '%(title)s', '--print', '%(uploader|channel|)s', '--print', '%(description|)s',
      url.href,
    ],
    { timeoutMs: Math.min(timeoutMs, 40000), maxChars: 50000 },
  )
  if (meta.code !== 0 || !meta.stdout.trim()) return null
  const lines = meta.stdout.replace(/\r/g, '').split('\n')
  const title = (lines[0] || '').trim()
  if (!title) return null
  const uploader = (lines[1] || '').trim()
  const description = lines.slice(2).join('\n').trim()

  // 字幕尽力而为：成功则附上字幕文本（可关）
  let subtitleText = ''
  if (config.reach?.video?.subtitles !== false) {
    subtitleText = await trySubtitles(url, timeoutMs)
  }
  const parts = [`视频平台：${url.hostname}`, `标题：${title}`]
  if (uploader) parts.push(`作者：${uploader}`)
  if (description) parts.push(`简介：${description.slice(0, 500)}`)
  if (subtitleText) parts.push(`字幕内容（前段）：\n${subtitleText}`)
  return videoResult('yt-dlp', parts.join('\n'))
}

/** 用 yt-dlp 拉自动字幕到临时目录，读出纯文本后立即清理 */
async function trySubtitles(url, timeoutMs) {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-sub-'))
  try {
    const r = await runCli(
      'yt-dlp',
      [
        '--no-playlist', '--skip-download', '--no-warnings', '--socket-timeout', '15',
        '--write-subs', '--write-auto-subs',
        '--sub-langs', 'zh-CN,zh,zh-Hans,zh-Hans-CN,en',
        '--sub-format', 'vtt/srt/best',
        '-o', path.join(dir, 'sub'),
        url.href,
      ],
      { timeoutMs: Math.min(timeoutMs, 40000), maxChars: 20000 },
    )
    if (r.code !== 0) return ''
    const file = (fs.readdirSync(dir) || []).find((f) => /\.(vtt|srt)$/i.test(f))
    if (!file) return ''
    const raw = fs.readFileSync(path.join(dir, file), 'utf8')
    // 去时间轴/序号/标签，留纯文本
    const text = raw
      .replace(/^WEBVTT.*$/gm, '')
      .replace(/^\d+$/gm, '')
      .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3}.*$/gm, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .split('\n').map((s) => s.trim()).filter(Boolean)
    // 自动字幕常见逐行重复，相邻去重
    const dedup = text.filter((line, i) => i === 0 || line !== text[i - 1])
    return dedup.join(' ').slice(0, 3000)
  } catch {
    return ''
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败无害 */ }
  }
}

/** V2EX：主题页走公开 API 拿标题+正文 */
async function fetchV2ex(url, timeoutMs) {
  const m = url.pathname.match(/^\/t\/(\d+)/)
  if (!m) return null // 节点页/其他页面交给通用链
  const topicId = m[1]
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.min(timeoutMs, 12000))
  try {
    const res = await fetch(`https://www.v2ex.com/api/topics/show.json?id=${topicId}`, {
      signal: ac.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    })
    if (!res.ok) return null
    const arr = await res.json()
    const t = Array.isArray(arr) && arr[0]
    if (!t) return null
    const summary = [`V2EX 主题：${t.title}`, `节点：${t.node?.title || t.node?.name || '未知'}`, `正文：${String(t.content || '（无正文）').slice(0, 1200)}`].join('\n')
    logger.info(`[reach] V2EX API命中: ${topicId}`)
    return { ok: true, kind: 'page', source: 'v2ex', summary }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** GitHub 仓库：gh CLI 拿描述+README（gh 未登录/未装则返回 null 走通用链） */
async function fetchGithub(url, timeoutMs) {
  const m = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/)
  if (!m) return null
  const repo = `${m[1]}/${m[2].replace(/\.git$/, '')}`
  if (!(await hasCli('gh'))) return null
  const meta = await runCli('gh', ['api', `repos/${repo}`, '--jq', '{full_name, description, stargazers_count, language, homepage}'], { timeoutMs: 15000, maxChars: 20000 })
  if (meta.code !== 0) return null
  let info = {}
  try { info = JSON.parse(meta.stdout) } catch { return null }
  const parts = [`GitHub 仓库：${info.full_name || repo}`]
  if (info.description) parts.push(`描述：${info.description}`)
  if (info.stargazers_count != null) parts.push(`Stars：${info.stargazers_count}　语言：${info.language || '未知'}`)
  const readme = await runCli('gh', ['api', `repos/${repo}/readme`, '-H', 'Accept: application/vnd.github.raw'], { timeoutMs: 15000, maxChars: 4000 })
  if (readme.code === 0 && readme.stdout.trim()) {
    parts.push(`README 摘录：${readme.stdout.replace(/\r/g, '').slice(0, 1500)}`)
  }
  logger.info(`[reach] gh CLI命中: ${repo}`)
  return { ok: true, kind: 'page', source: 'github', summary: parts.join('\n') }
}

/**
 * L0 入口：域名命中白名单则调用对应适配器。
 * 返回适配器结果（null = 未命中或适配失败，调用方继续下一层）。
 */
export async function platformFetch(urlStr, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000
  const v = await validateExternalUrl(urlStr)
  if (!v.ok) {
    // SSRF 拦截直接终态，不进任何层
    return { ok: false, error: v.error, fatal: true }
  }
  const key = matchPlatform(v.url.hostname)
  if (!key) return null
  // 视频渠道整体开关（reach.video.enabled=false 时 B站/YouTube/抖音走通用抓取链）
  const isVideoPlatform = key === 'bilibili' || key === 'youtube' || key === 'douyin'
  if (isVideoPlatform && config.reach?.video?.enabled === false) return null
  try {
    switch (key) {
      case 'bilibili': return await fetchBilibili(v.url, timeoutMs)
      case 'youtube':
      case 'douyin': return await fetchViaYtDlp(v.url, timeoutMs)
      case 'v2ex': return await fetchV2ex(v.url, timeoutMs)
      case 'github': return await fetchGithub(v.url, timeoutMs)
      default: return null
    }
  } catch (err) {
    logger.warn(`[reach] 平台适配器异常(${key}): ${err?.message || err}`)
    return null
  }
}
