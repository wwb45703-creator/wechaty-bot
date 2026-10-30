import config from '../config-loader.js'
import { logger } from '../logger.js'
import { admitMessage } from '../messaging.js'
import { handlePrivateMessage } from './private.js'
import { handleRoomMessage, checkRoomTrigger, cleanMention } from './room.js'
import { handleImageMessage, isVisionEnabled } from './on-image.js'
import { handleEmoticonMessage, isEmoticonEnabled } from './on-emoticon.js'
import { handleLinkMessage, hasProcessableLink } from './on-link.js'
import { handleSearchMessage, detectSearchIntent } from './search.js'
import { isForgetCommand } from './text-response.js'

/** Testable dispatcher: admission precedes every message type and its side effects. */
export function createOnMessage({ conf = config, admit = (msg, room) => admitMessage(msg, room, conf), typeMap = null,
  handlers = { private: handlePrivateMessage, room: handleRoomMessage, image: handleImageMessage,
    emoticon: handleEmoticonMessage, link: handleLinkMessage, search: handleSearchMessage }, trigger = checkRoomTrigger } = {}) {
  return async function dispatch(msg) {
    if (msg.self?.()) return
    const room = msg.room?.() || null
    const a = await admit(msg, room)
    if (!a) return { status: 'denied' }
    const types = typeMap || (await import('wechaty')).types.Message
    const text = String(msg.text?.() || '')
    const type = msg.type()
    const question = room ? cleanMention(text, a.selfName, a.rc) : text.trim()
    const shortcut = isForgetCommand(question) || question === '我的记忆' ||
      (conf.dingDong && question.toLowerCase() === 'ding') || (conf.menu?.enabled && question === conf.menu?.keyword)
    if (room) {
      a.trigger = await trigger(msg, text, a.rc)
      a.shouldAt = a.rc?.atSender === true || (a.rc?.atSender !== false && a.trigger.triggerReason === 'mention')
      if (!a.trigger.triggered && !shortcut) return { status: 'not-triggered' }
    }
    if (type === types.Image) {
      if (conf.vision?.enabled !== false) return handlers.image(msg, room, a)
      return
    }
    if (type === types.Emoticon) {
      if (conf.emoticon?.enabled !== false) return handlers.emoticon(msg, room, a)
      return
    }
    if (!(type === types.Text || (type === types.Unknown && !/^\s*</.test(text))) || !text.trim()) return
    if (shortcut) return room ? handlers.room(msg, room, a) : handlers.private(msg, a)
    const query = detectSearchIntent(question)
    if (query) return handlers.search(msg, room, query, a)
    if (hasProcessableLink(text, a.topic, room?.id)) return handlers.link(msg, room, text, a)
    return room ? handlers.room(msg, room, a) : handlers.private(msg, a)
  }
}
const dispatch = createOnMessage()
export async function onMessage(msg) {
  try { return await dispatch(msg) }
  catch (error) { logger.error(`消息处理失败: ${error?.code || error?.name || 'unknown'}`) }
}
// Compatibility helper for callers which only need process-local duplicate detection.
const ids = new Map()
export function isDuplicateMessage(id) {
  if (!id) return false
  const stamp = Date.now(), found = ids.has(id)
  ids.set(id, stamp)
  if (ids.size > 1000) for (const [key, at] of ids) if (stamp - at > 60000) ids.delete(key)
  return found
}
