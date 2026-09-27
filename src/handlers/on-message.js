import { types } from 'wechaty'
import { logger } from '../logger.js'
import { handlePrivateMessage } from './private.js'
import { handleRoomMessage } from './room.js'
import { handleImageMessage, isVisionEnabled } from './on-image.js'

/**
 * 消息总入口：只处理文本消息，按私聊/群聊分流
 */
export async function onMessage(msg) {
  try {
    if (msg.self()) return // 忽略机器人自己发的
    const text = msg.text()
    const room = msg.room() // wechaty 1.20 中是同步方法：私聊返回 null/undefined
    const type = msg.type()
    logger.info(`[诊断] 收到消息 type=${type} room=${room ? 'Y' : 'N'} text=${String(text).slice(0, 30)}`)
    if (!text || !text.trim()) return

    // 看图说话：图片消息单独走视觉链路（私聊+群聊）
    if (type === types.Message.Image && isVisionEnabled()) {
      await handleImageMessage(msg, room)
      return
    }

    // 只处理"纯文本"消息：Text 类型，或 puppet-xp 判型失败但内容仍是普通文字的 Unknown
    const isPlainText = type === types.Message.Text ||
      (type === types.Message.Unknown && !/^\s*</.test(text))
    if (!isPlainText) return

    if (room) {
      await handleRoomMessage(msg, room)
    } else {
      await handlePrivateMessage(msg)
    }
  } catch (err) {
    logger.error(`消息处理异常: ${err?.stack || err}`)
  }
}
