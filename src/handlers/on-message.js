import { types } from 'wechaty'
import config, { findRoomConfig } from '../config-loader.js'
import { logger } from '../logger.js'
import { handlePrivateMessage } from './private.js'
import { handleRoomMessage } from './room.js'
import { handleImageMessage, isVisionEnabled } from './on-image.js'
import { handleLinkMessage, hasProcessableLink } from './on-link.js'
import { handleSearchMessage, detectSearchIntent } from './search.js'
import { checkRoomTrigger } from './room.js'

/**
 * 消息总入口：只处理文本消息，按私聊/群聊分流
 */
/** 统一准入检查：私聊查白名单，群聊查是否在 config.rooms 登记（支持 roomId 或 topic 匹配） */
async function isAdmitted(msg, room) {
  if (room) {
    const topic = await room.topic().catch(() => '')
    return Boolean(findRoomConfig(topic, room.id))
  }
  const t0 = msg.talker()
  const wl = config.private?.whitelist || []
  if (wl.length === 0) return true
  const name = t0.name()
  const alias = await t0.alias().catch(() => '')
  return wl.includes(name) || (alias && wl.includes(alias))
}

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
      if (await isAdmitted(msg, room)) {
        await handleImageMessage(msg, room)
      }
      return // 图片消息不落入文本链路
    }

    // 只处理"纯文本"消息：Text 类型，或 puppet-xp 判型失败但内容仍是普通文字的 Unknown
    const isPlainText = type === types.Message.Text ||
      (type === types.Message.Unknown && !/^\s*</.test(text))
    if (!isPlainText) return

    // 聊天搜索：触发词开头（"搜一下 XX"）；群聊需满足与文本一致的触发条件（@/唤醒词）
    // 放在链接分支之前，防止含 URL 的搜索词被链接处理截走
    const searchQuery = detectSearchIntent(text)
    if (searchQuery) {
      let admitted = await isAdmitted(msg, room)
      if (admitted && room) {
        const topic = await room.topic().catch(() => '')
        const rc = findRoomConfig(topic, room.id)
        admitted = Boolean(rc) && (await checkRoomTrigger(msg, text, rc)).triggered
      }
      if (admitted) {
        await handleSearchMessage(msg, room, searchQuery)
        return
      }
      logger.info(`[搜索] 未准入，落回普通聊天: ${String(text).slice(0, 40)}`)
    }

    // 链接识别：消息含 URL 时优先走抓取回复
    // 准入检查（与文本一致）：私聊白名单、群聊仅 config.rooms 已登记的群
    const roomTopic = room ? await room.topic().catch(() => '') : null
    const isLinkCandidate = hasProcessableLink(text, roomTopic, room?.id)
    if (isLinkCandidate) {
      if (!(await isAdmitted(msg, room))) {
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
