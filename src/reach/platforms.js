import config from '../config-loader.js'
import { externalFetch } from '../external-http.js'
import { validateExternalUrl } from '../url-utils.js'

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


/** Only built-in public APIs use the checked HTTP transport. External CLI extractors are quarantined. */
export async function platformFetch(urlStr, opts = {}) {
  const valid = await validateExternalUrl(urlStr, { signal: opts.signal })
  if (!valid.ok) return { ...valid, fatal: true }
  const platform = matchPlatform(valid.url.hostname)
  if (!platform) return null
  if (['bilibili', 'youtube', 'douyin'].includes(platform) && config.reach?.video?.enabled === false) return null
  const request = opts.client || externalFetch
  const read = async url => {
    const response = await request(url, opts)
    return response.ok ? response.json() : null
  }
  try {
    if (platform === 'bilibili') {
      let target = valid.url
      if (target.hostname === 'b23.tv') {
        const response = await request(target.href, opts)
        target = new URL(response.url)
      }
      const bvid = target.pathname.match(/BV[0-9A-Za-z]{8,}/i)?.[0]
      if (!bvid) return null
      const value = await read(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
      const info = value?.code === 0 && value.data
      if (!info) return null
      return { ok: true, kind: 'video', source: 'bilibili', summary:
        [`标题：${info.title}`, `UP主：${info.owner?.name || '未知'}`, `简介：${String(info.desc || '').slice(0, 1200)}`].join('\n') }
    }
    if (platform === 'v2ex') {
      const id = valid.url.pathname.match(/^\/t\/(\d+)/)?.[1]
      if (!id) return null
      const values = await read(`https://www.v2ex.com/api/topics/show.json?id=${id}`)
      const info = values?.[0]
      return info ? { ok: true, kind: 'page', source: 'v2ex', summary: `V2EX 主题：${info.title}\n正文：${String(info.content || '').slice(0, 1200)}` } : null
    }
    if (platform === 'github') {
      const match = valid.url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/)
      if (!match) return null
      const repo = `${match[1]}/${match[2].replace(/\.git$/, '')}`
      const info = await read(`https://api.github.com/repos/${repo}`)
      if (!info?.full_name) return null
      const readme = await read(`https://api.github.com/repos/${repo}/readme`)
      const text = readme?.encoding === 'base64' ? Buffer.from(readme.content || '', 'base64').toString('utf8').slice(0, 1500) : ''
      return { ok: true, kind: 'page', source: 'github', summary:
        `GitHub 仓库：${info.full_name}\n描述：${info.description || ''}\nStars：${info.stargazers_count || 0}\n${text}` }
    }
    return null
  } catch (error) {
    return error.fatal ? { ok: false, fatal: true, error: error.message, code: error.code } : null
  }
}
