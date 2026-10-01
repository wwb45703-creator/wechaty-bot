import { types } from 'wechaty'
import config, { findRoomConfig } from '../config-loader.js'
import { logger } from '../logger.js'
import { handlePrivateMessage } from './private.js'
import { handleRoomMessage } from './room.js'
import { handleImageMessage, isVisionEnabled } from './on-image.js'
import { handleLinkMessage, hasProcessableLink } from './on-link.js'

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

    // 看图说话：图片消息单独走视觉链路（准入与文本一致：私聊白名单、群聊仅已登记群）
    if (type === types.Message.Image && isVisionEnabled()) {
      let admitted
      if (room) {
        admitted = Boolean(findRoomConfig(await room.topic().catch(() => '')))
      } else {
        const t0 = msg.talker()
        const wl = config.private?.whitelist || []
        admitted = wl.length === 0 || wl.includes(t0.name()) || wl.includes(await t0.alias().catch(() => ''))
      }
      if (admitted) await handleImageMessage(msg, room)
      return // 图片消息不落入文本链路
    }

    // 只处理"纯文本"消息：Text 类型，或 puppet-xp 判型失败但内容仍是普通文字的 Unknown
    const isPlainText = type === types.Message.Text ||
      (type === types.Message.Unknown && !/^\s*</.test(text))
    if (!isPlainText) return

    // 链接识别：消息含 URL 时优先走抓取回复
    // 准入检查（与文本一致）：私聊白名单、群聊仅 config.rooms 已登记的群
    const isLinkCandidate = hasProcessableLink(text, room ? await room.topic().catch(() => '') : null)
    if (isLinkCandidate) {
      let admitted
      if (room) {
        admitted = Boolean(findRoomConfig(await room.topic().catch(() => '')))
      } else {
        const t0 = msg.talker()
        const wl = config.private?.whitelist || []
        admitted = wl.length === 0 || wl.includes(t0.name()) || wl.includes(await t0.alias().catch(() => ''))
      }
      if (!admitted) {
        logger.info(`[链接] 未准入（白名单/登记群限制），忽略: ${String(text).slice(0, 40)}`)
        return
      }
      await handleLinkMessage(msg, room, text)
      return
    }

    if (room) {
      await handleRoomMessage(msg, room)
    } else {
      await handlePrivateMessage(msg)
    }
  } catch (err) {
    logger.error(`消息处理异常: ${err?.stack || err}`)
  }
}
