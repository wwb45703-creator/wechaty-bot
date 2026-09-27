/**
 * 人设切换命令处理：人设列表 / 变成<角色> / 切换人设 <角色> / 恢复默认
 * handlePersonaCommand 返回 true 表示 text 是人设命令且已回复。
 */
import config from './config-loader.js'
import { getPersonaName, setPersonaName } from './state.js'

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
 * @param {(t: string) => Promise<void>} p.reply 回复函数
 * @returns {boolean} 是否为人设命令（已处理）
 */
export function handlePersonaCommand({ text, ref, reply }) {
  if (!config.personas) return false
  const t = String(text || '').trim()
  const current = getActivePersonaName(ref)

  if (t === '人设列表' || t === '角色列表') {
    reply(`可选角色：${roleNames().join(' / ')}\n当前激活：${current}\n切换说"变成<角色名>"，恢复默认说"恢复默认"`)
    return true
  }
  if (t === '恢复默认' || t === '恢复人设') {
    setPersonaName(ref, defaultName())
    reply(`已恢复默认人设：${defaultName()} ✓`)
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
  reply(`人设已切换：${name} ✓`)
  return true
}
