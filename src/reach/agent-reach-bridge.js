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


/** Quarantined: the CLI has an independent network stack, outside the bounded transport. */
export async function fetchViaAgentReach() { return null }
