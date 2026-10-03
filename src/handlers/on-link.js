/**
 * 链接识别处理：群里/私聊的消息带 URL 时，抓取网页内容并以人设回复。
 *
 * 触发规则（on-message.js 分流）：
 *  - 私聊：文本含链接即处理
 *  - 群聊：仅 config.rooms 已登记的群自动处理（未登记群维持 @ 触发逻辑，防泛滥）
 * 防刷屏：links.cooldownSeconds（每群/每人独立冷却）
 * 回复：一次性人设调用（key 唯一、不污染会话记忆）→ 多气泡延迟发送
 */

import config from '../config-loader.js'
import { logger } from '../logger.js'
import { chat } from '../ai.js'
import { checkRate, recordReply } from '../rate-limit.js'
import { splitBubbles, sendBubbles, stripAtMentions } from '../utils.js'
import { getActivePersonaName } from '../persona-commands.js'
import { extractFirstUrl } from '../url-utils.js'
import { fetchRich } from '../reach/index.js'

function linksConf() {
  return config.links || {}
}

/** 该群是否开启链接自动识别（私聊 roomTopic 为 null，恒启用） */
export function isLinkEnabledFor(roomTopic) {
  const lc = linksConf()
  if (lc.enabled === false) return false
  if (!roomTopic) return true // 私聊直接启用
  // 群聊只对 config.rooms 登记过的群生效
  return (config.rooms || []).some((r) => r.topic === roomTopic)
}

/** 消息文本是否值得走链接处理（含 URL 且功能开启） */
export function hasProcessableLink(text, roomTopic) {
  if (!isLinkEnabledFor(roomTopic)) return false
  return Boolean(extractFirstUrl(text))
}

/**
 * 链接消息处理入口
 * @param msg     wechaty 消息
 * @param room    群聊对象（私聊为 null）
 * @param text    消息文本
 */
export async function handleLinkMessage(msg, room, text) {
  const url = extractFirstUrl(text)
  if (!url) return

  const lc = linksConf()
  const topic = room ? await room.topic().catch(() => '(未知群名)') : null
  const talker = msg.talker()
  const name = talker.name()
  const key = room ? `link:room:${room.id}` : `link:private:${talker.id}`

  // 冷却（防链接刷屏；不计每日上限）
  const limit = checkRate(key, lc.cooldownSeconds ?? 30, 0)
  if (!limit.allowed) {
    logger.info(`[链接] 冷却中（剩余 ${limit.remainingSeconds ?? '?'}s）: ${topic || name}`)
    return
  }

  logger.info(`[链接] ${topic ? `群[${topic}] ${name}` : name} 分享链接: ${url.slice(0, 80)}`)

  // 抓取（分层降级链：平台API→原生→Scrapling→Jina→浏览器，可能耗时较久，静默等结果）
  const page = await fetchRich(url, {
    timeoutMs: lc.timeoutSeconds ? lc.timeoutSeconds * 1000 : 20000,
    maxBytes: lc.maxBytes || 400000,
    summaryChars: lc.summaryChars || 1200,
  })

  // 组装给 AI 的素材：
  // 网页内容放 system 侧（8B 模型对"长内容+指令"的 user 消息会当成对话续写），
  // user 只留极短指令
  const scene = room
    ? `当前是微信群"${topic}"的群聊，群成员 ${name} 刚在群里分享了这个链接。你的回复会自动@${name}。`
    : `当前是微信私聊，好友 ${name} 刚给你分享了这个链接。`
  let systemExtra
  let userText
  if (page.ok && page.kind === 'video') {
    const summary = page.summary.length > (lc.summaryChars || 1200) ? page.summary.slice(0, lc.summaryChars || 1200) + '……' : page.summary
    systemExtra = `${scene}\n\n【视频信息】(来源: ${page.source})\n${summary}\n\n你的任务：基于上面的信息，用一两句话说说这是个什么视频、值不值得看（有字幕内容就顺带剧透一点内容）。保持你的说话风格，不要开场白和说明。`
    userText = '我发的这个视频是啥？'
  } else if (page.ok) {
    const summary = page.summary.length > (lc.summaryChars || 1200) ? page.summary.slice(0, lc.summaryChars || 1200) + '……' : page.summary
    systemExtra = `${scene}\n\n【网页内容】\n${summary}\n\n你的任务：基于上面的网页内容，输出一两句话的点评或吐槽。只输出点评本身，不要任何开场白、说明或角色扮演。`
    userText = '点评一下我刚分享的这个链接。'
  } else {
    systemExtra = `${scene}\n\n链接打不开的原因：${page.error}\n\n你的任务：输出一句话告诉对方你打不开这个链接，保持你的说话风格。只输出这一句话。`
    userText = '我刚才发的链接你打不开吗？'
  }

  const reply = await chat({
    key: `link-once:${Date.now()}`, // 唯一 key：有人设、不污染会话记忆
    userText,
    systemExtra,
    personaName: getActivePersonaName({ scope: room ? 'room' : 'private', roomId: room?.id, userId: talker.id }),
  })

  if (!reply) {
    await msg.say('（这个链接我处理失败了，等你换个链接试试）').catch(() => {})
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

  recordReply(key, 0)
  logger.info(`[链接] 已回复 ${topic ? `群[${topic}] ${name}` : name}（ok=${page.ok}${page.source ? `,source=${page.source}` : ''}）`)
}
