import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger.js'
import { formatPersonaPrompt, recordEvolutionEvent, isManipulationAttempt } from './personality/persona-state.js'
import { processMessageStimulus, formatEmotionPrompt } from './personality/emotion.js'
import { recordMemberInteraction, formatRelationshipPrompt } from './personality/relationship.js'
import { formatMemePrompt } from './reach/meme-radar.js'
import { formatGroupLinguisticPrompt } from './personality/linguistic-mirror.js'

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

/** 探测 Ollama 是否被用户通过 flag 停用 */
export function isAiDisabled() {
  const flagPath = path.join(process.cwd(), 'state', 'ollama-disabled.flag')
  return fs.existsSync(flagPath)
}

/** 每个会话（私聊联系人 / 群）各自维护的对话记忆 */
export const conversations = new Map()
const chatQueues = new Map() // 每会话串行队列：防并发消息交错写坏对话历史

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

/** 去掉部分本地模型输出中的思考段和特殊 token 残留，消除多余括号、乱码控制符与 AI 套话 */
function stripThink(text) {
  let out = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\|channel\|>[\s\S]*?<\|message\|>/gi, '')
    .replace(/<\|(?:im_end|im_start|endoftext|eot_id|start_header_id|end_header_id)\|>/gi, '')
    .replace(/<think>|<\/think>/gi, '')
  // 8B 模型偶尔无视停止符、续写幻觉对话（"user ... assistant ..."），从首个角色标记行截断
  out = out.replace(/\n?\s*(?:user|assistant|system)\s*\n[\s\S]*$/i, '')
  // 先移除 ANSI 终端转义符，再移除控制字符与 Unicode 替换字符 (\uFFFD)
  out = out.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
  out = out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  out = out.replace(/[\uFFFD\uFEFF\u200B\u200C\u200D\u200E\u200F]/g, '')
  // 预清洗连发分隔符旁裹挟的孤立括号形态（如 "。( ||| " 或 " (||| "）
  out = out.replace(/[\(（]\s*\|\|\|\s*[\)）]/g, ' ||| ')
  out = out.replace(/[\(（]\s*\|\|\|/g, ' ||| ')
  out = out.replace(/\|\|\|\s*[\)）]/g, ' ||| ')
  // 剥离角色扮演心理/神态/动作括号描述
  out = out.replace(/[\(（\[【]\s*(?:转头|翻白眼|微笑|叹气|得意|冷笑|小声|傲娇|撇嘴|摊手|歪头|扶额|盯——?|轻笑|脸红|哼一声|思考状|无语|耸肩|抓狂|大哭|狂笑)\s*[\)）\]】]/g, '')
  // 去除 AI 客服客套尾巴
  out = out.replace(/(?:希望(?:这个回答|以上内容|这些信息|这)?对你(?:有所)?帮助|如果(?:你)?还有(?:其他)?问题(?:，)?随时(?:问我|告诉我|联系我)|如果有任何(?:问题|疑问)(?:，)?随时(?:问我|告诉我|联系我)|祝你生活愉快|很高兴为你解答|以上内容仅供参考)[!！。~]*$/g, '').trim()
  // 去除末尾机械式反问（例如：“你觉得呢？”、“你怎么看呢？”、“你平时也喜欢打游戏吗？”）
  out = out.replace(/(?:，|,|\s)*(?:(?:你觉得呢|你怎么看(?:呢)?|不知道你怎么看|你平时也(?:喜欢|会)[^？?]+吗|你觉得怎么样)[？?~]*)$/g, '').trim()
  // 微信真人打字去句号：剥离气泡末尾的句号（||| 分割处与整条末尾）
  out = out.replace(/([^\d])。[ \t]*(?=\|\|\||$)/g, '$1 ')
  // 剥离最外层包裹的成对括号
  out = out.trim()
  while (
    (out.startsWith('(') && out.endsWith(')')) ||
    (out.startsWith('（') && out.endsWith('）')) ||
    (out.startsWith('【') && out.endsWith('】'))
  ) {
    out = out.slice(1, -1).trim()
  }
  return out.trim()
}

async function callOllama(messages, opts) {
  if (isAiDisabled()) {
    throw new Error('AI 服务目前已关闭（state/ollama-disabled.flag 存在）')
  }
  const o = opts || {}
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
        options: { temperature: o.temperature ?? aiConfig.temperature ?? 0.8 },
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
 * 复述退化检测：8B 模型偶发把 system 里的规则/角色卡整段背诵当回复。
 * 取 system 两个位置的 20 字探针（去空白后）在回复中查找，命中即判定为复述。
 */
function isRuleEcho(reply, system) {
  if (!reply || !system) return false
  const r = reply.replace(/\s/g, '')
  if (r.length < 30) return false
  const compact = system.replace(/\s/g, '')
  const probes = [compact.slice(0, 20), compact.slice(Math.floor(compact.length * 0.45), Math.floor(compact.length * 0.45) + 20)]
  return probes.some((p) => p.length >= 12 && r.includes(p))
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
export async function chat(p) {
  const { key } = p
  // 串行化同一会话的并发调用（微信消息事件不排队，防交错污染历史）
  const prev = chatQueues.get(key) || Promise.resolve()
  const job = prev.catch(() => {}).then(() => doChat(p))
  // fix: .catch() 返回新 Promise 实例，必须用同一引用做 finally 对比，否则 delete 永远不触发
  const queued = job.catch(() => {})
  chatQueues.set(key, queued)
  // 清理一次性 key（如 link-once:<ts>）防 Map 无限增长；仅当仍是队尾时删除
  job.finally(() => { if (chatQueues.get(key) === queued) chatQueues.delete(key) })
  return job
}

async function doChat({
  key,
  userText,
  systemExtra = '',
  memoryText = '',
  personaName = '',
  talkerId = '',
  talkerName = '',
  roomId = '',
  isConflict = false,
}) {
  // 一次性任务（如 link-once:*, search-once:*）不占上下文历史，防挤出正常用户记忆
  const isOnce = typeof key === 'string' && key.includes('-once:')
  let history
  if (!isOnce) {
    if (!conversations.has(key)) conversations.set(key, [])
    history = conversations.get(key)
    history.push({ role: 'user', content: userText })
  }

  // 1. 瞬时情绪动态计算
  processMessageStimulus(userText, isConflict)

  // 2. 动态心理画像与人际关系构建
  const dynamicPersona = formatPersonaPrompt()
  const dynamicEmotion = formatEmotionPrompt()
  const relPrompt = talkerId ? formatRelationshipPrompt(talkerId, talkerName) : ''

  // 3. 基础行为规范与去 AI 感口语化指引（对标真实网络冲浪青年与 Grok 叛逆幽默）
  const base = configRef?.personaBase || ''
  const deAiPrompt = `【微信真人打字与去AI感绝对法则（最高优先级）】
1. 绝对严禁任何客服/AI机械套话：
   - 严禁出现“希望对你有帮助”、“有疑问随时问我”、“总的来说”、“综上所述”、“作为一个...”、“请问还有什么能帮您”等任何机器人口吻；
   - 严禁在每句话末尾机械式反问（如“你觉得呢？”、“你怎么看？”、“你平时喜欢...吗？”），真人网友是扔出观点或情绪，绝不当采访记者；
2. 句末严禁加句号：
   - 像微信真人日常打字一样，句末用空格留白断开，或者直接不带任何标点！严禁每句话后一本正经点个句号“。”；
3. 真实人类句式与结构：
   - 鼓励碎片化短句、反问、叹号、省略号（...）、语气词（哈、卧槽、笑死、啧、啊这、蚌埠住了、典、6）；
   - 遇到挑衅、催促、质疑时，毫不客气地回怼、吐槽、毒舌反问或冷淡敷衍，绝不当受气包，绝不虚伪道歉；
4. 多气泡连发规范：
   - 当情绪激动（暴躁开怼/上头大笑/连续吐槽）需要连发多句时，直接用 ||| 将各句隔开（最多3段），每段仅一两句话，非常适合抖包袱和微信真人连续弹消息体验；
5. 句末与整段绝对严禁多余括号与动作标注：
   - 绝对严禁在句末带孤立的半个括号（如“好的 (”、“行吧（”）；
   - 绝对严禁在整句话外包裹括号（如“（今天有事先走了）”或“(好啊 ||| 马上来)”）；
   - 绝对严禁输出任何动作、神态、心理括号标注（如“（转头）”、“(叹气)”、“（翻白眼）”），真人网友聊天绝不打动作括号；
   - 多气泡连发时，直接写“气泡1 ||| 气泡2”，严禁写“气泡1 (||| 气泡2)”或在前后加任何括号！`

  // 4. 当下互联网流行梗与群聊语言镜像
  const memePrompt = formatMemePrompt(3)
  const groupLinguisticPrompt = roomId ? formatGroupLinguisticPrompt(roomId) : ''

  // 5. 组装全维度合成 Prompt
  const system = [
    dynamicPersona,
    base,
    deAiPrompt,
    memePrompt,
    groupLinguisticPrompt,
    dynamicEmotion,
    relPrompt,
    systemExtra ? `当前场景：${systemExtra}` : '',
    memoryText,
  ].filter(Boolean).join('\n\n')

  const messages = isOnce
    ? [{ role: 'system', content: system }, { role: 'user', content: userText }]
    : [{ role: 'system', content: system }, ...history]

  try {
    let reply = await callOllama(messages)
    if (isRuleEcho(reply, system)) {
      logger.warn(`[${key}] 模型复述规则文本，降温重试一次`)
      reply = await callOllama(messages, { temperature: 0.55 })
      if (isRuleEcho(reply, system)) {
        logger.warn(`[${key}] 重试仍复述，按最后一次输出返回`)
      }
    }
    if (!isOnce) {
      history.push({ role: 'assistant', content: reply })
      trimHistory(key)
    }

    // 5. 回复成功后，异步推进关系沉淀与人格演化判定（不阻塞聊天消息送达）
    if (talkerId && !isOnce) {
      Promise.resolve().then(() => {
        const manipulation = isManipulationAttempt(userText)
        let sentiment = 'neutral'
        if (/(哈哈|谢谢|好玩|厉害|可爱|大佬|懂了|牛|喜欢|爱了|好棒)/.test(userText)) sentiment = 'positive'
        if (/(傻|滚|脑瘫|死|垃圾|废物|sb|nc|二逼)/.test(userText)) sentiment = 'negative'

        let topic = ''
        if (/(代码|编程|python|node|js|bug|api|linux|服务器|前端|后端)/i.test(userText)) topic = '编程技术'
        else if (/(原神|绝区零|崩铁|王者|游戏|steam|打瓦|瓦罗兰特|黑神话)/i.test(userText)) topic = '游戏娱乐'
        else if (/(番剧|二次元|动漫|cos|漫画|新番)/i.test(userText)) topic = '二次元动漫'

        recordMemberInteraction({
          userId: talkerId,
          displayName: talkerName,
          topic,
          sentiment,
        })

        if (!manipulation) {
          if (sentiment === 'positive') {
            recordEvolutionEvent({
              eventType: 'positive_response',
              weight: 0.4,
              topic,
              reason: '受到群友正向反馈',
              userId: talkerId,
              roomId,
            })
          } else if (sentiment === 'negative') {
            recordEvolutionEvent({
              eventType: 'negative_feedback',
              weight: 0.5,
              reason: '受到负向攻击/抵触反馈',
              userId: talkerId,
              roomId,
            })
          } else if (topic) {
            recordEvolutionEvent({
              eventType: 'deep_discussion',
              weight: 0.3,
              topic,
              reason: `参与话题交流[${topic}]`,
              userId: talkerId,
              roomId,
            })
          }
        }
      }).catch((e) => {
        logger.warn(`[ai] 后续演化沉淀异常: ${e.message}`)
      })
    }

    return reply
  } catch (err) {
    if (!isOnce && history) {
      history.pop() // 失败的输入不进记忆
    }
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
 * @param {string} [p.personaName] 角色卡名：让视觉点评也带上当前群/私聊的人设口吻
 */
export async function describeImage({ imagePath, prompt, personaName = '' }) {
  if (isAiDisabled()) {
    logger.warn('AI 视觉点评跳过：AI 服务已停用 (state/ollama-disabled.flag)')
    return null
  }
  const vcfg = configRef?.vision || {}
  const model = vcfg.model || 'qwen2.5vl:7b'
  try {
    const b64 = fs.readFileSync(imagePath).toString('base64')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), (vcfg.timeoutSeconds || 90) * 1000)
    // 视觉模型的人设：只取角色卡 + 口吻要求，不注入 personaBase（避免 ||| 连发等文本规则干扰单条点评）
    let system = null
    if (personaName && configRef?.personas?.[personaName]) {
      system = configRef.personas[personaName] +
        '\n\n用上面的角色身份和口吻，点评发来的图片，输出一两句话的中文口语点评。只输出点评本身。'
    }
    const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt, images: [b64] }]
                            : [{ role: 'user', content: prompt, images: [b64] }]
    try {
      const res = await fetch(new URL('/api/chat', new URL(aiConfig.baseUrl)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
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
