import config, { findRoomConfig } from '../config-loader.js'
import { chat, isAiDisabled } from '../ai.js'
import { getMemory, isMemoryEnabled } from '../memory.js'
import { handlePersonaCommand } from '../persona-commands.js'
import { getRoomDirectives, clearRoomDirectives, parsePreference } from '../personality/room-directives.js'
import { recentContext } from '../conversation-context.js'
import { explicitCommand } from '../reply-policy.js'
import { answerKnowledgeCommand } from '../knowledge/store.js'
import { readAstrBotConnection } from '../reach/astrbot-connection.js'
import { formatBotReply } from '../utils.js'

export function isForgetCommand(text) { return /^\/?忘记我(?:全部会话|所有会话)?$/.test(String(text || '').trim()) }
export function isAllForget(text) { return /(?:全部|所有)会话$/.test(String(text || '').trim()) }
// 白名单群可通过 config.rooms[].brain === 'astrbot' 选择 AstrBot 作为大脑；
// 普通社交对话永远走本地大脑，总开关是 config.astrbot.bridge.enabled。
export function isAstrBotBridgeRoom(room, topic) {
  if (!room) return false
  if (config.astrbot?.bridge?.enabled !== true) return false
  if (readAstrBotConnection().enabled !== true) return false
  return findRoomConfig(topic, room?.id)?.brain === 'astrbot'
}

// 群聊自动桥接的回复限一句话：截到第一个句读（。！？!?…~）为止；无句读则原样返回。
export function firstSentence(text) {
  const t = String(text || '').trim()
  const m = t.match(/^[^。！？!?…~]*[。！？!?…~]/)
  return (m ? m[0] : t).trim()
}
export async function produceTextResponse(ctx, question) {
  const { msg, room, topic, scope, epoch, signal, key, name } = ctx
  if (question.startsWith('/') && explicitCommand(question, config)) question = question.slice(1)
  if (isForgetCommand(question)) return { text: isAllForget(question) ? '已删除所有会话中与你有关的成长和记忆记录' : '已删除本会话所有角色中与你有关的成长和记忆记录', learn: false }
  if (config.dingDong && question.toLowerCase() === 'ding') return { text: 'dong', learn: false }
  if (config.menu?.enabled && question === config.menu?.keyword) return { text: config.menu?.content || '', learn: false }
  const knowledgeReply = answerKnowledgeCommand(question)
  if (knowledgeReply !== null) return { text: knowledgeReply, learn: false }
  if (question === '我的记忆') {
    const memory = getMemory(scope)
    const lines = [...(memory.facts || []).slice(-12).map((f) => `- ${f.text}`), ...(memory.episodes || []).slice(-5).map((e) => `- ${e.description}`)]
    return { text: lines.length ? `我记着的关于你的事：\n${lines.join('\n')}\n说“忘记我”可删除本会话各角色记录` : '还没有保存关于你的记忆', learn: false }
  }
  let commandReply
  if (await handlePersonaCommand({ text: question, ref: scope, reply: async (text) => { commandReply = text } })) return { text: commandReply, learn: false }
  if (/^(拍我|拍拍我|拍一下我|拍一拍)$/.test(question)) return { text: '拍一拍暂未开放', learn: false }
  if (room && ['查群ID', '群ID', '查群', '群信息'].includes(question)) {
    return { text: `群名：${topic}\n群ID：${room.id}\n配置群ID后，群改名仍能准确识别`, learn: false }
  }
  if (room && ['查看群指令', '群指令', '查看群约定', '群约定', '群要求'].includes(question)) {
    const directives = getRoomDirectives(room.id, scope)
    return { text: directives.length ? directives.map((d, i) => `${i + 1}. ${d.text}`).join('\n') : '本群当前角色还没有保存交流偏好', learn: false }
  }
  if (room && ['重置群指令', '清除群指令', '清空群指令', '清空群约定'].includes(question)) {
    clearRoomDirectives(room.id, scope)
    return { text: '已清除本群当前角色的交流偏好', learn: false }
  }
  const preference = parsePreference(question)
  // An explicit bridge is opt-in. It never receives ordinary social conversation.
  const explicitPlugin = /^\/?(?:astrbot|插件)(?:\s+([\s\S]*))?$/i.exec(question.trim())
  if (explicitPlugin) {
    if (readAstrBotConnection().enabled !== true) return { text: 'AstrBot 插件连接未启用，请在控制台插件中心启用连接。', learn: false }
    const command = String(explicitPlugin[1] || '').trim()
    if (!command) return { text: '用法：/插件 列表，或 /插件 /插件指令。', learn: false }
    const client = await import('../reach/astrbot-client.js')
    if (await client.isAstrBotAlive(1500, { signal })) {
      if (/^(?:列表|list)$/i.test(command)) {
        const plugins = await client.listInstalledPlugins({ signal })
        return { text: plugins.map((p) => `${p.display_name || p.name}: ${p.desc || ''}`).join('\n') || '没有启用的插件', learn: false }
      }
      const result = await client.chatWithAstrBot({ message: command, sessionId: key, username: name, signal })
      if (result.ok && result.reply) return { text: formatBotReply(result.reply), userText: question, extract: false }
    }
    return { text: '工具服务暂时不可用', learn: false }
  }
  // 自动桥接：命中 brain:"astrbot" 的群把触发消息交给 AstrBot 处理（sessionId=key 天然按群+人格隔离）。
  // AstrBot 不可达或回复失败时回退本地大脑，除非显式配置 fallbackToLocal === false。
  if (room && isAstrBotBridgeRoom(room, topic)) {
    const client = await import('../reach/astrbot-client.js')
    if (await client.isAstrBotAlive(1500, { signal })) {
      const result = await client.chatWithAstrBot({ message: question, sessionId: key, username: name, signal })
      if (result.ok && result.reply) return { text: formatBotReply(firstSentence(result.reply)), userText: question, extract: false }
    }
    if (config.astrbot?.bridge?.fallbackToLocal === false) return { text: 'AstrBot 服务暂时不可用', learn: false }
  }
  const systemExtra = room ? '当前为微信群，请自然接住当前话题。' : '当前为微信一对一聊天。'
  const contextRows = recentContext.read(scope, { excludeId: msg.id })
  const reply = await chat({ key, scope, epoch, signal, messageId: ctx.messageId, userText: question,
    research: config.reach?.search?.implicit === true, contextRows,
    privateNames: [name, topic, scope.subjectId, scope.accountId, room?.id, ...contextRows.map(row => row.name)],
    systemExtra, personaName: scope.personaId, talkerId: scope.subjectId, talkerName: name, roomId: room?.id || '' })
  if (!reply && config.ai?.replyQuality?.enabled === true && !isAiDisabled()) return { text: '', learn: false, extract: false }
  return { text: formatBotReply(reply || (isAiDisabled() ? 'AI 对话服务暂时未开启' : config.ai?.fallbackReply || '暂时没连上，稍后再聊')),
    userText: question, historyKey: reply ? key : undefined, learn: Boolean(reply), preference: reply ? preference : null, extract: isMemoryEnabled() }
}
