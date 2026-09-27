import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger.js'

/**
 * AI 模块：调用本地 Ollama 的 /api/chat 接口。
 * baseUrl 只能来自本机 config.json（不允许来自聊天内容的任意 URL），
 * 且仅接受 http/https 协议，避免任何 SSRF 风险。
 */

let aiConfig = null
let configRef = null
let persona = ''

export function initAi(config) {
  aiConfig = config.ai
  configRef = config
  persona = config.persona
}

/** 每个会话（私聊联系人 / 群）各自维护的对话记忆 */
const conversations = new Map()

function trimHistory(key) {
  const list = conversations.get(key) || []
  const keep = Math.max(0, (aiConfig.maxHistory || 8) * 2)
  if (list.length > keep) conversations.set(key, list.slice(-keep))
  // 会话总量上限：聊过的人太多时淘汰最早的会话（防 Map 无限增长）
  const MAX_CONVERSATIONS = 400
  if (conversations.size > MAX_CONVERSATIONS) {
    const excess = conversations.size - MAX_CONVERSATIONS
    let removed = 0
    for (const k of conversations.keys()) {
      if (removed >= excess) break
      conversations.delete(k)
      removed++
    }
  }
}

export function resetConversation(key) {
  conversations.delete(key)
}

/** 去掉部分本地模型输出中的思考段 */
function stripThink(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|channel\|>[\s\S]*?<\|message\|>/gi, '')
    .trim()
}

async function callOllama(messages) {
  const base = new URL(aiConfig.baseUrl)
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`AI baseUrl 协议不支持: ${base.protocol}`)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (aiConfig.timeoutSeconds || 180) * 1000)
  try {
    const res = await fetch(new URL('/api/chat', base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: aiConfig.model,
        messages,
        stream: false,
        think: false,
        // 文本模型常驻显存（默认 2 小时），避免每波对话第一条消息等 12 秒冷加载
        keep_alive: aiConfig.keepAlive || '2h',
        options: { temperature: aiConfig.temperature ?? 0.8 },
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    const data = await res.json()
    const content = stripThink(data?.message?.content)
    if (!content) throw new Error('Ollama 返回了空回复')
    return content
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 带记忆的多轮对话
 * @param {object} p
 * @param {string} p.key        会话 key（private:<id> / room:<topic>）
 * @param {string} p.userText   用户输入
 * @param {string} [p.systemExtra] 追加到人设后的场景说明
 * @param {string} [p.memoryText]  长期记忆文本块（来自 memory.formatForPrompt）
 * @param {string} [p.personaName] 角色卡名（config.personas 的键；缺省用默认角色）
 */
export async function chat({ key, userText, systemExtra = '', memoryText = '', personaName = '' }) {
  if (!conversations.has(key)) conversations.set(key, [])
  const history = conversations.get(key)
  history.push({ role: 'user', content: userText })

  // 人设 = 角色卡 + 共享行为规则（chat 可按会话切换角色卡）
  const roleCard = (personaName && configRef?.personas?.[personaName]) || configRef?.persona || persona
  const base = configRef?.personaBase || ''
  const system = roleCard
    + (base ? `\n\n${base}` : '')
    + (systemExtra ? `\n\n当前场景：${systemExtra}` : '')
    + (memoryText ? `\n\n${memoryText}` : '')
  const messages = [{ role: 'system', content: system }, ...history]

  try {
    const reply = await callOllama(messages)
    history.push({ role: 'assistant', content: reply })
    trimHistory(key)
    return reply
  } catch (err) {
    history.pop() // 失败的输入不进记忆
    logger.error(`AI 调用失败 [${key}]: ${err.message}`)
    return null
  }
}

/** 无记忆的一次性生成（用于主动话题等） */
export async function generateOnce(prompt) {
  try {
    const reply = await callOllama([
      { role: 'system', content: persona },
      { role: 'user', content: prompt },
    ])
    return reply
  } catch (err) {
    logger.error(`AI 一次性生成失败: ${err.message}`)
    return null
  }
}

/**
 * 看图说话：把本地图片发给视觉模型，返回吐槽/描述文本，失败返回 null
 */
export async function describeImage({ imagePath, prompt }) {
  const vcfg = configRef?.vision || {}
  const model = vcfg.model || 'qwen2.5vl:7b'
  try {
    const b64 = fs.readFileSync(imagePath).toString('base64')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), (vcfg.timeoutSeconds || 90) * 1000)
    try {
      const res = await fetch(new URL('/api/chat', new URL(aiConfig.baseUrl)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt, images: [b64] }],
          stream: false,
          think: false,
          options: { temperature: vcfg.temperature ?? 0.9 },
          keep_alive: vcfg.keepAlive ?? '5m',
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)
      const data = await res.json()
      const content = stripThink(data?.message?.content)
      if (!content) throw new Error('视觉模型返回空')
      return content
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    logger.error(`看图说话失败 [${path.basename(String(imagePath))}]: ${err.message}`)
    return null
  }
}

const EXTRACTOR_SYSTEM =
  '你是记忆提取器。从一段微信对话中提取关于说话用户的"长期记忆要点"——' +
  '即几周后仍然有价值的稳定信息：姓名/称呼、年龄、身份（学生/职业）、家庭、好友关系、' +
  '喜好与讨厌的事物、养宠物、重要计划或约定、身体健康等。' +
  '不要提取：寒暄、临时情绪、当下正在聊的八卦、你无法确认的猜测。' +
  '每条要点是一句简短中文陈述（以用户为主语，如"用户在上高中"）。' +
  '只输出 JSON：{"facts":["要点1","要点2"]}，没有可提取的就输出 {"facts":[]}，不要输出其他任何内容。'

/**
 * 长期记忆提取：从一轮对话中提取稳定要点（独立于聊天人设，模型无关的通用指令）
 * 返回 string[]（可能为空），失败返回 null
 */
export async function extractFacts({ userText, assistantReply }) {
  try {
    const content = await callOllama([
      { role: 'system', content: EXTRACTOR_SYSTEM },
      {
        role: 'user',
        content: `【用户说】${String(userText).slice(0, 500)}\n【助手回复】${String(assistantReply).slice(0, 300)}`,
      },
    ])
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return []
    const parsed = JSON.parse(m[0])
    if (Array.isArray(parsed?.facts)) return parsed.facts.map((f) => String(f).trim()).filter(Boolean)
    return []
  } catch (err) {
    logger.error(`记忆提取失败: ${err.message}`)
    return null
  }
}
