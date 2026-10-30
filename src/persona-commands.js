import config from './config-loader.js'
import { getPersonaName, setPersonaName } from './state.js'
import { getSocialState } from './social/index.js'

const roleNames = () => Object.keys(config.personas || {})
const defaultName = () => config.defaultPersona || roleNames()[0] || '鹅王'
function stateRef(ref = {}) {
  if (!ref.conversationId) return ref
  const room = ref.conversationId.startsWith('room:')
  return { ...ref, scope: room ? 'room' : 'private', roomId: room ? ref.conversationId.slice(5) : undefined,
    userId: room ? ref.subjectId : ref.conversationId.slice(8) }
}
export function getActivePersonaName(ref) {
  const fallback = defaultName(), name = getPersonaName(stateRef(ref), fallback)
  return config.personas && Object.hasOwn(config.personas, name) ? name : fallback
}
export function isPersonaCommand(text) {
  return /^(?:人设列表|角色列表|性格状态|人格状态|心理状态|恢复默认|恢复人设|变成.{1,40}|切换人设[:：\s]*.{1,40})$/.test(String(text || '').trim())
}
export async function handlePersonaCommand({ text, ref, reply }) {
  if (!config.personas) return false
  const t = String(text || '').trim(), current = getActivePersonaName(ref)
  if (t === '人设列表' || t === '角色列表') {
    await reply(`可选角色：${roleNames().join(' / ')}\n当前激活：${current}\n变成<角色名> 可切换，各角色保留独立对话和成长记录`)
    return true
  }
  if (['性格状态', '人格状态', '心理状态'].includes(t)) {
    const state = getSocialState({ ...ref, personaId: current })
    const traits = Object.entries(state.persona?.traits || {}).map(([k, v]) => `${k}: ${v}`).join('，')
    await reply(`【${current} · 当前成长状态】\n${traits}\n共同互动: ${state.relationship?.interactionCount || 0} 次\n兴趣: ${(state.persona?.hobbies || []).map((h) => h.name || h).join('、') || '尚未形成'}\n这些是行为状态记录，可通过“忘记我”删除此会话中与你有关的记录`)
    return true
  }
  let name
  if (t === '恢复默认' || t === '恢复人设') name = defaultName()
  else name = (t.match(/^变成(.{1,40})$/) || t.match(/^切换人设[:：\s]*(.{1,40})$/))?.[1]?.trim()
  if (!name) return false
  if (!Object.hasOwn(config.personas, name)) await reply(`没有叫“${name}”的角色，可选：${roleNames().join(' / ')}`)
  else if (name === current) await reply(`当前就是${name}`)
  else {
    setPersonaName(stateRef(ref), name)
    await reply(`已切换为${name}；该角色保留自己的对话记录`)
  }
  return true
}
