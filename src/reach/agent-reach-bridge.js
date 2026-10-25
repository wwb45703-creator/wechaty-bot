/**
 * Agent-Reach CLI 桥接适配器
 *
 * 调用本机已安装的 agent-reach 全局 CLI (v1.6.0+)，利用其覆盖的 16+ 个全网平台
 * (B站、Twitter/X、YouTube、GitHub、Reddit、V2EX、知乎等) 标准化抽取富文本与元数据。
 *
 * 约定：
 *  - 所有的 URL 必须在进入本层前通过 validateExternalUrl (SSRF 防护)
 *  - 全量捕获标准 JSON，超时或出错静默返回 null，落入下一层降级
 */

import { runCli } from './spawn-utils.js'
import { logger } from '../logger.js'
import { validateExternalUrl } from '../url-utils.js'
import config from '../config-loader.js'

/** 哪些域名优先使用 Agent Reach 解析（社交媒体、视频、技术社区等） */
const SPECIALIZED_DOMAINS = [
  'twitter.com', 'x.com',
  'github.com',
  'youtube.com', 'youtu.be',
  'reddit.com',
  'xiaohongshu.com', 'xhslink.com',
  'xueqiu.com',
  'zhihu.com',
  'tieba.baidu.com',
  'weibo.com', 'weibo.cn',
]

/** 是否属于 Agent Reach 特长平台 */
export function isAgentReachSpecialized(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase()
    return SPECIALIZED_DOMAINS.some((d) => host === d || host.endsWith('.' + d))
  } catch {
    return false
  }
}

/**
 * 通过 Agent-Reach CLI 读取链接内容
 * @param {string} urlStr 目标链接 (已通过 SSRF 校验)
 * @param {object} [opts] summaryChars 长度上限, timeoutMs 超时时间, onlySpecialized 是否仅特长域名触发
 * @returns {Promise<{ok: boolean, kind: 'page'|'video', source: string, summary: string, fatal?: boolean}|null>}
 */
export async function fetchViaAgentReach(urlStr, opts = {}) {
  const arc = config.reach?.agentReach || {}
  if (arc.enabled === false) return null

  const v = await validateExternalUrl(urlStr)
  if (!v.ok) {
    return { ok: false, error: v.error, fatal: true }
  }

  if (opts.onlySpecialized && !isAgentReachSpecialized(urlStr)) {
    return null
  }

  const cmd = arc.command || 'agent-reach'
  const timeoutMs = opts.timeoutMs || (arc.timeoutSeconds ? arc.timeoutSeconds * 1000 : 25000)
  const maxChars = opts.summaryChars || 1200

  try {
    const res = await runCli(cmd, ['read', urlStr], { timeoutMs, maxChars: 100000 })
    if (res.code !== 0 || !res.stdout) {
      if (res.timedOut) {
        logger.warn(`[reach] Agent-Reach 读取超时: ${urlStr.slice(0, 50)}`)
      }
      return null
    }

    let data
    try {
      data = JSON.parse(res.stdout)
    } catch {
      return null
    }

    if (!data.ok || !Array.isArray(data.items) || data.items.length === 0) {
      return null
    }

    const item = data.items[0]
    const platform = data.channel || 'web'

    // 格式化输出内容
    const parts = []
    if (item.title) parts.push(`标题：${item.title}`)
    if (item.author) parts.push(`作者/UP主：${item.author}`)
    if (item.raw?.stats) {
      const s = item.raw.stats
      const statsStr = [
        s.view != null ? `播放 ${s.view}` : '',
        s.like != null ? `点赞 ${s.like}` : '',
        s.coin != null ? `投币 ${s.coin}` : '',
      ].filter(Boolean).join(' | ')
      if (statsStr) parts.push(`数据：${statsStr}`)
    } else if (item.raw?.stargazers_count != null) {
      parts.push(`Stars：${item.raw.stargazers_count} | 语言：${item.raw.language || '未知'}`)
    }

    const textContent = (item.text || item.raw?.description || '').trim()
    if (textContent) {
      const truncated = textContent.length > maxChars ? textContent.slice(0, maxChars) + '……' : textContent
      parts.push(`内容摘要：\n${truncated}`)
    }

    const summary = parts.join('\n').trim()
    if (!summary) return null

    const isVideo = platform === 'bilibili' || platform === 'youtube' || platform === 'douyin'
    logger.info(`[reach] Agent-Reach 命中 (${platform}): ${urlStr.slice(0, 60)}`)

    return {
      ok: true,
      kind: isVideo ? 'video' : 'page',
      source: `agent-reach:${platform}`,
      summary,
    }
  } catch (err) {
    logger.warn(`[reach] Agent-Reach 桥接异常: ${err.message}`)
    return null
  }
}
