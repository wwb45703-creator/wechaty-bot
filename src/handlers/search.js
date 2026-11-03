import config from '../config-loader.js'
import { chat } from '../ai.js'
import { processMessage } from '../messaging.js'
import { sanitizeQuery } from '../reach/search.js'
import { recentContext } from '../conversation-context.js'
function searchConf() {
  return config.reach?.search || {}
}

/**
 * 检测消息是否为搜索意图。
 * @returns {string|null} 搜索词（已清洗），非搜索返回 null
 */
export function detectSearchIntent(text) {
  const sc = searchConf()
  if (config.reach?.enabled === false || sc.enabled === false) return null
  const triggers = Array.isArray(sc.triggers) && sc.triggers.length ? sc.triggers : ['帮我搜索一下', '帮我搜一下', '帮我搜', '搜索一下', '搜一下', '搜索']
  const t = String(text || '').trim().replace(/^\//, '')
  for (const trig of triggers) {
    if (!trig) continue
    if (t.startsWith(trig)) {
      // 剥掉触发词后剩余部分作为搜索词（清理首尾冒号/空白）
      const rest = t.slice(trig.length).replace(/^[\s:：,，。]+/, '').trim()
      const query = sanitizeQuery(rest)
      return query || null
    }
  }
  return null
}

/**
 * 类 Grok 隐式时效性搜索意图检测：
 * 当用户并未说“搜一下”，但提问明显指向最新发生的时事、今日热点、网络热梗、具体人事物最新动态时：
 * 例如：“今天微博热搜第一是什么瓜”、“听说XX公司怎么了”、“最近那个XX事件发生啥事了”
 * @returns {string|null} 清洗后的搜索词，无隐式意图返回 null
 */
export function detectImplicitSearchIntent(text) {
  const sc = searchConf()
  if (config.reach?.enabled === false || sc.enabled === false) return null
  const t = String(text || '').trim()
  if (t.length < 4 || t.length > 50) return null

  // 1. 强时效指示词
  const temporalPattern = /^(?:今天|今日|昨天|最近|刚才|这几天)/
  // 2. 强吃瓜/事件/热搜意图
  const eventPattern = /(?:热搜|有什么瓜|怎么回事|啥情况|发生(?:了)?(?:甚么|什么)事|出什么事了|新出(?:的)?|最新消息)/

  const hasTemporal = temporalPattern.test(t)
  const hasEvent = eventPattern.test(t)

  if (hasTemporal || hasEvent) {
    // 排除纯打招呼、纯提问自身人设（如“今天天气如何”、“今天心情好吗”、“今天吃啥”）
    if (/(天气|心情|吃啥|吃了没|几点|你好|早上好|晚安)/.test(t)) return null
    // 提取核心查询
    const query = sanitizeQuery(t)
    return query || null
  }

  return null
}

export async function handleSearchMessage(msg, room, query, admission = null) {
  if (config.reach?.enabled === false || config.reach?.search?.enabled === false) return
  return processMessage({ msg, room, admission, kind: 'search', producer: async (ctx) => {
    const contextRows = recentContext.read(ctx.scope, { excludeId: msg.id })
    const reply = await chat({ key: ctx.key, scope: ctx.scope, epoch: ctx.epoch, signal: ctx.signal,
      userText: query, personaName: ctx.scope.personaId, research: true, researchForce: true, contextRows,
      privateNames: [ctx.name, ctx.topic, ctx.scope.subjectId, ctx.scope.accountId, room?.id, ...contextRows.map(row => row.name)],
      systemExtra: '用户明确请求公开检索；只依据已核实资料简短回答，不堆砌搜索结果。' })
    return { text: reply || '', historyKey: reply ? ctx.key : undefined, learn: Boolean(reply), userText: msg.text?.() || query, extract: false }
  } })
}
