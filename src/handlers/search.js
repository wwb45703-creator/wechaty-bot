/**
 * 聊天搜索命令：触发词开头（"搜一下 XX"/"帮我搜 XX"等）→ 必应搜索 → 人设汇总播报。
 *
 * 准入与链接处理一致：私聊白名单、群聊仅登记群且需满足 mention/唤醒词触发。
 * 限流：search 段冷却 + 每日上限（计入每日额度，防搜索刷屏）。
 * 回复：一次性人设调用（key 唯一、不污染会话记忆）→ 多气泡延迟发送。
 */

import config from '../config-loader.js'
import { logger } from '../logger.js'
import { chat } from '../ai.js'
import { checkRate, recordReply } from '../rate-limit.js'
import { splitBubbles, sendBubbles, stripAtMentions } from '../utils.js'
import { getActivePersonaName } from '../persona-commands.js'
import { webSearch, sanitizeQuery } from '../reach/search.js'

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
  const t = String(text || '').trim()
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
 * 搜索消息处理入口
 * @param msg     wechaty 消息
 * @param room    群聊对象（私聊为 null）
 * @param query   搜索词（detectSearchIntent 的返回值）
 */
export async function handleSearchMessage(msg, room, query) {
  const sc = searchConf()
  const topic = room ? await room.topic().catch(() => '(未知群名)') : null
  const talker = msg.talker()
  const name = talker.name()
  const key = room ? `search:room:${room.id}` : `search:private:${talker.id}`

  const limit = checkRate(key, sc.cooldownSeconds ?? 60, sc.dailyLimit ?? 20)
  if (!limit.allowed) {
    const why = limit.reason === 'dailyLimit' ? '今日搜索次数用完了' : `搜索冷却中（剩余 ${limit.remainingSeconds ?? '?'}s）`
    logger.info(`[搜索] ${why}: ${topic || name}`)
    if (limit.reason === 'dailyLimit') {
      // 用 recordReply(key, 0) 重置冷却节流提示（不增加日计数），防止连环刷"次数用完"
      recordReply(key, 0)
      await (room ? room.say(`@${name} ${why}`, talker) : msg.say(why)).catch(() => {})
    }
    return
  }

  logger.info(`[搜索] ${topic ? `群[${topic}] ${name}` : name} 搜索: "${query.slice(0, 50)}"`)

  const found = await webSearch(query, { numResults: sc.numResults || 6 })

  const scene = room
    ? `当前是微信群"${topic}"的群聊，群成员 ${name} 让你帮忙搜索。你的回复会自动@${name}。`
    : `当前是微信私聊，好友 ${name} 让你帮忙搜索。`
  let systemExtra
  let userText
  if (found && found.results.length) {
    const list = found.results
      .map((r, i) => `${i + 1}. ${r.title}${r.snippet ? `\n   摘要：${r.snippet}` : ''}\n   链接：${r.url}`)
      .join('\n')
    systemExtra = `${scene}\n\n【搜索"${query}"的结果】\n${list}\n\n你的任务：基于搜索结果，用你的说话风格聊聊搜到了什么——挑最相关最有意思的两三条说，别念清单，可以在结尾自然地提一句"想看哪个发序号对应的链接"之类的话（不强制）。如果结果明显不相关，就直说没搜到靠谱的。不要 markdown 格式，不要罗列链接本身（链接域名可以口语化提）。`
    userText = `搜一下：${query}`
  } else {
    systemExtra = `${scene}\n\n搜索"${query}"没有拿到结果（网络原因或词太生僻）。\n\n你的任务：输出一句话告诉对方没搜到，建议换个说法再试，保持你的说话风格。`
    userText = `搜"${query}"有结果吗？`
  }

  const reply = await chat({
    key: `search-once:${Date.now()}`,
    userText,
    systemExtra,
    personaName: getActivePersonaName({ scope: room ? 'room' : 'private', roomId: room?.id, userId: talker.id }),
  })

  if (!reply) {
    await msg.say('（这次搜索处理失败了，稍后再试试？）').catch(() => {})
    return
  }

  const bubbles = splitBubbles(reply)
  const selfName = msg.wechaty?.currentUser?.name?.() || msg.wechaty?.userSelf?.()?.name?.() || ''
  await sendBubbles(async (t, i) => {
    const clean = room ? stripAtMentions(t, [name, selfName].filter(Boolean)) : t
    if (room) {
      if (i === 0) await room.say(`@${name} ${clean}`, talker)
      else await room.say(clean)
    } else {
      await msg.say(clean)
    }
  }, bubbles, config.ai?.replyDelaySeconds)

  recordReply(key, sc.dailyLimit ?? 20)
  logger.info(`[搜索] 已回复 ${topic ? `群[${topic}] ${name}` : name}（engine=${found?.engine || 'none'}）`)
}
