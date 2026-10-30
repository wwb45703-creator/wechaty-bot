import { dataPath } from '../runtime-paths.js'
/**
 * meme-radar.js — 实时网络热梗雷达 (Meme Radar RAG)
 *
 * 核心功能：
 *  1. 维护互联网前沿流行梗与当代网络黑话语汇池（state/meme-radar.json）
 *  2. 定期与动态向模型注入当下时代切片的流行梗概念，彻底消除“模型知识截止于过去”的脱节感
 *  3. 支持从真实聊天对话中自学习群友提到的新梗新词
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..', '..')
const MEME_FILE = dataPath('state', 'meme-radar.json')

// 初始高频互联网当红热梗库（涵盖日常冲浪、反讽调侃、情绪表达）
const INITIAL_MEMES = [
  { term: '硬控', explanation: '某件事或搞笑画面极具吸引力，让人目不转睛看呆很久', usage: '这视频直接硬控了我整整三分钟' },
  { term: '草台班子', explanation: '看似光鲜严谨的组织或事物，内部运行逻辑其实极其草率混乱', usage: '世界本质上就是一个巨大的草台班子' },
  { term: '汗流浃背', explanation: '面对尴尬、惊悚或无法反驳的真相时内心慌张', usage: '这发言直接给哥们整得汗流浃背了' },
  { term: '纯爱战神', explanation: '对真挚单一情感极度推崇，反对一切海王和拉扯套路', usage: '纯爱战神应声倒地' },
  { term: '尊嘟假嘟', explanation: '模仿可爱口吻表达“真的假的”带着调侃意味', usage: '尊嘟假嘟O.o' },
  { term: '狠狠拿下', explanation: '高调自信地完成某件事或取得成果', usage: '今天这顿大餐必须狠狠拿下' },
  { term: '破防了', explanation: '心理防线被一瞬间击溃，既可指感动也可指被戳中痛点破防', usage: '看这一句话我直接破防了' },
  { term: '典中典', explanation: '极具代表性、屡见不鲜的经典刻板言论或名场面', usage: '这操作只能说典中典了' },
  { term: '好好好', explanation: '连续三个好，反语表达无奈、服气或无语妥协', usage: '好好好，这么玩是吧' },
  { term: '小刀拉屁股', explanation: '开眼了，形容见识到了不可思议的奇葩离谱操作', usage: '这可真是小刀拉屁股——开了眼了' },
]

let memeCache = null

/** 读取热梗库（原子读写与自愈修复） */
export function getMemeData() {
  if (memeCache) return memeCache

  try {
    if (fs.existsSync(MEME_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MEME_FILE, 'utf8'))
      if (parsed && Array.isArray(parsed.trendingMemes) && parsed.trendingMemes.length > 0) {
        memeCache = parsed
        return memeCache
      }
    }
  } catch (err) {
    logger.warn(`[meme-radar] 读取热梗库异常，重建初始库: ${err.message}`)
  }

  memeCache = {
    updatedAt: new Date().toISOString(),
    trendingMemes: [...INITIAL_MEMES],
  }
  saveMemeData()
  return memeCache
}

function saveMemeData() {
  if (!memeCache) return
  const tmp = `${MEME_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  try {
    fs.mkdirSync(path.dirname(MEME_FILE), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(memeCache, null, 2), 'utf8')
    fs.renameSync(tmp, MEME_FILE)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

/**
 * 学习/吸收一个新网络梗
 */
export function learnNewMeme(term, explanation, usage = '') {
  if (!term || typeof term !== 'string') return false
  const cleanTerm = term.trim().slice(0, 20)
  if (!cleanTerm) return false

  const data = getMemeData()
  const exists = data.trendingMemes.find((m) => m.term === cleanTerm)
  if (exists) {
    if (explanation) exists.explanation = explanation
    if (usage) exists.usage = usage
  } else {
    data.trendingMemes.unshift({
      term: cleanTerm,
      explanation: explanation || '网络流行表达',
      usage: usage || `这波属于是${cleanTerm}`,
    })
    // 限制上限最多 50 个高频梗
    if (data.trendingMemes.length > 50) data.trendingMemes.pop()
  }
  data.updatedAt = new Date().toISOString()
  saveMemeData()
  return true
}

/**
 * 格式化为注入 System Prompt 的当下网络梗指引
 * 随机选择 3~5 个当前热门梗作为提示词，让模型随时具备自然使用互联网流行语的语境
 */
export function formatMemePrompt(limit = 4) {
  const data = getMemeData()
  const list = data.trendingMemes || []
  if (list.length === 0) return ''

  // 洗牌选取 limit 个梗
  const shuffled = [...list].sort(() => 0.5 - Math.random()).slice(0, limit)
  const items = shuffled.map((m) => `「${m.term}」（${m.explanation}，如：“${m.usage}”）`).join('、')

  return `【当前互联网流行黑话参考】
你对当下的网络热梗非常熟稔，在聊天中若语境自然契合，可像资深网瘾少年一样随性引用以下现代网络梗（自然运用，别硬套）：
${items}`
}
