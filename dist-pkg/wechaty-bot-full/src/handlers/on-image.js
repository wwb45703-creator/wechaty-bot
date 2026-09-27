/**
 * 图片消息处理（看图说话）：私聊图片直接吐槽；群聊图片在群未被禁用时吐槽。
 * 视觉模型与文本模型分开配置，Ollama 按显存自动换模。
 */
import config from '../config-loader.js'
import { logger } from '../logger.js'
import { describeImage } from '../ai.js'
import { checkRate, recordReply } from '../rate-limit.js'
import { splitBubbles, sendBubbles } from '../utils.js'
import { parseImagePaths, findReadableImage, cleanupTemp } from '../image-utils.js'

const DEFAULT_PROMPT =
  '这是微信里收到的一张图片。用一两句话点评或吐槽这张图，' +
  '像一个爱玩梗的年轻人在群里说话，中文口语化，简短，不要用markdown，不要描述你看到的字面细节太多。'

export function isVisionEnabled() {
  return config.vision?.enabled !== false
}

export async function handleImageMessage(msg, room) {
  if (!isVisionEnabled()) return
  try {
    const talker = msg.talker()
    const name = talker.name()
    const isRoom = Boolean(room)
    const topic = isRoom ? await room.topic().catch(() => '(未知群名)') : null

    const key = isRoom ? `vision:room:${topic}` : `vision:private:${talker.id}`
    const cooldown = config.vision?.cooldownSeconds ?? 10
    const limit = checkRate(key, cooldown, 0)
    if (!limit.allowed) {
      logger.info(`看图限流中（${isRoom ? `群[${topic}]` : '私聊'} ${name}）`)
      return
    }

    const candidates = parseImagePaths(msg.text())
    // 大图落盘比消息通知慢，带退避重试解析（0/0.8s/2s/4s）
    let imageFile = null
    for (const delay of [0, 800, 2000, 4000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay))
      imageFile = findReadableImage(candidates)
      if (imageFile) break
    }
    if (!imageFile) {
      logger.warn(`图片消息无法解析出可读文件（${isRoom ? `群[${topic}]` : '私聊'} ${name}），候选: ${JSON.stringify(candidates)}`)
      return
    }

    const prompt = config.vision?.prompt || DEFAULT_PROMPT
    logger.info(`看图说话 -> ${isRoom ? `群[${topic}]` : '私聊'} ${name}: ${imageFile}`)
    const comment = await describeImage({ imagePath: imageFile, prompt })
    cleanupTemp(imageFile)

    if (!comment) {
      logger.warn('视觉模型无输出，跳过回复')
      return
    }

    const bubbles = splitBubbles(comment)
    if (isRoom) {
      await sendBubbles(async (t, i) => {
        if (i === 0) await room.say(`@${name} ${t}`, talker)
        else await room.say(t)
      }, bubbles)
    } else {
      await sendBubbles((t) => msg.say(t), bubbles)
    }
    recordReply(key, 0)
  } catch (err) {
    logger.error(`图片处理异常: ${err?.stack || err}`)
  }
}
