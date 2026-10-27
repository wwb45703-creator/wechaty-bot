/**
 * 表情包消息处理（Emoticon）：
 * 当收到微信自定义表情包或大图表情 (type=5) 时，根据"鹅王"拟真人格进行趣味接梗互动。
 *
 * 特性：
 *  1. 严格冷却防刷屏：单人/单群 10 秒冷却；
 *  2. 接地气的人格互动：幽默调侃、斗图回击、偷图接梗；
 *  3. 连带促进关系演化与记忆互动。
 */

import config from '../config-loader.js'
import { logger } from '../logger.js'
import { checkRate, recordReply } from '../rate-limit.js'
import { splitBubbles, sendBubbles, stripAtMentions } from '../utils.js'
import { recordMemberInteraction } from '../personality/relationship.js'
import { applyStimulus } from '../personality/emotion.js'

const EMOTICON_BANTERS = [
  '发这表情包是几个意思😂',
  '这表情包有点魔性啊，先收了👍',
  '（盯——）这表情很传神啊',
  '斗图是吧？我还没怕过谁🤡',
  '偷图了偷图了，归我了哈哈',
  '这小表情，有话直说嘛😄',
  '甩个表情包就跑？说说最近有啥好玩的',
  '6，这个表情包很有精神',
]

/** 是否启用表情包互动 */
export function isEmoticonEnabled() {
  return config.emoticon?.enabled !== false
}

export async function handleEmoticonMessage(msg, room) {
  if (!isEmoticonEnabled()) return
  try {
    const talker = msg.talker()
    const name = talker.name()
    const isRoom = Boolean(room)
    const topic = isRoom ? await room.topic().catch(() => '(未知群名)') : null

    const key = isRoom ? `emoticon:room:${topic}` : `emoticon:private:${talker.id}`
    const cooldown = config.emoticon?.cooldownSeconds ?? 10
    const limit = checkRate(key, cooldown, 0)
    if (!limit.allowed) {
      logger.info(`表情包互动冷却中（${isRoom ? `群[${topic}]` : '私聊'} ${name}）`)
      return
    }

    // 随机选择一条符合鹅王口吻的趣味接梗
    const replyText = EMOTICON_BANTERS[Math.floor(Math.random() * EMOTICON_BANTERS.length)]

    // 更新即时情绪（受到表情包互动激发微量愉悦感与兴奋感）
    applyStimulus({ pleasureDelta: 5, arousalDelta: 5 })

    // 记录轻度关系互动
    recordMemberInteraction(talker.id, {
      sentiment: 'positive',
      topic: '表情包互动',
    })

    const bubbles = splitBubbles(replyText)
    if (isRoom) {
      await sendBubbles(async (t, i) => {
        const body = stripAtMentions(t)
        const textToSend = i === 0 ? `@${name} ${body}` : body
        logger.info(`[回复群表情] 群[${topic}] -> ${textToSend}`)
        return room.say(textToSend, talker)
      }, bubbles, config.ai?.replyDelaySeconds)
    } else {
      await sendBubbles((t) => {
        logger.info(`[回复私聊表情] ${name} -> ${t}`)
        return msg.say(t)
      }, bubbles, config.ai?.replyDelaySeconds)
    }

    recordReply(key, 0)
  } catch (err) {
    logger.error(`表情包处理异常: ${err?.stack || err}`)
  }
}
