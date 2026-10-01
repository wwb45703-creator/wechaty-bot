/**
 * 人设切换命令处理：人设列表 / 变成<角色> / 切换人设 <角色> / 恢复默认
 * handlePersonaCommand 返回 true 表示 text 是人设命令且已回复。
 *
 * 完全切换：切换/恢复成功后调用 resetConversation(chatKey) 清空该会话的
 * 短期对话记忆——新角色不会读到旧角色的上下文（否则会延续旧口吻）。
 */
import config from './config-loader.js'
import { getPersonaName, setPersonaName } from './state.js'
import { resetConversation } from './ai.js'

function roleNames() {
  return Object.keys(config.personas || {})
}

function defaultName() {
  return config.defaultPersona || roleNames()[0] || '鹅王'
}

export function getActivePersonaName(ref) {
  const fallback = defaultName()
  const name = getPersonaName(ref, fallback)
  // 状态里存的角色可能已被从 config 删除，回落默认
  return config.personas?.[name] ? name : fallback
}

/**
 * @param {object} p
 * @param {string} p.text    清理过 @ 噪音的文本
 * @param {object} p.ref     { scope, roomId?, userId }
 * @param {string} [p.chatKey] 该会话的 chat() 会话键（room:<topic> / private:<id>），切换人设时用于清空短期记忆
 * @param {(t: string) => Promise<void>} p.reply 回复函数
 * @returns {boolean} 是否为人设命令（已处理）
 */
export function handlePersonaCommand({ text, ref, chatKey, reply }) {
  if (!config.personas) return false
  const t = String(text || '').trim()
  const current = getActivePersonaName(ref)

  if (t === '人设列表' || t === '角色列表') {
    reply(`可选角色：${roleNames().join(' / ')}\n当前激活：${current}\n切换说"变成<角色名>"，恢复默认说"恢复默认"`)
    return true
  }
  if (t === '恢复默认' || t === '恢复人设') {
    setPersonaName(ref, defaultName())
    if (chatKey) resetConversation(chatKey)
    reply(`已恢复默认人设：${defaultName()} ✓（对话记忆已重置，完全以新身份开始）`)
    return true
  }
  let name = null
  const m1 = t.match(/^变成(.{1,12})$/)
  const m2 = t.match(/^切换人设[:：\s]*(.{1,12})$/)
  name = m1 ? m1[1].trim() : m2 ? m2[1].trim() : null
  if (!name) return false
  if (!config.personas[name]) {
    reply(`没有叫"${name}"的角色哦～可选：${roleNames().join(' / ')}`)
    return true
  }
  if (name === current) {
    reply(`当前就是${name}啦～`)
    return true
  }
  setPersonaName(ref, name)
  if (chatKey) resetConversation(chatKey)
  reply(`人设已完全切换：${name} ✓（之前的对话记忆已清空，现在是全新的人设）`)
  return true
}
