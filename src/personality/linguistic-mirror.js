/**
 * linguistic-mirror.js — 群聊语言镜像与俚语自适应系统 (Linguistic Mirroring Engine)
 *
 * 核心功能：
 *  1. 监听各群聊日常发言，自动提取本群独有的高频口头禅、特殊网络用语和接梗习惯
 *  2. 隔离存储至 state/slang/<roomId>.json，保证各群风格互不污染
 *  3. 在群聊回复时动态输出群特有的语言镜像提示词，让机器人说话就像本群老群友一样地道
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..', '..')
const SLANG_DIR = path.join(rootDir, 'state', 'slang')

// 常见中文高频网络俚语/口头禅模式库
const SLANG_PATTERNS = [
  /笑(?:嘻|死|麻)了/,
  /好{2,}|好(?:耶|的)/,
  /急了|典|孝|乐/,
  /纯纯的/,
  /硬控|破防/,
  /绷不住|离谱/,
  /带哥|佬|牛逼|666/,
  /寄了|摆烂|躺平/,
  /懂了|学到了/,
  /真实|太真实了/,
  /狠狠(?:拿下|爱了)/,
]

function sanitizeRoomId(roomId) {
  return String(roomId || 'default_room').replace(/[^\w\-@.]/g, '_')
}

function slangFileFor(roomId) {
  return path.join(SLANG_DIR, `${sanitizeRoomId(roomId)}.json`)
}

/**
 * 读取某个群的语言画像数据
 */
export function getGroupLinguisticProfile(roomId) {
  if (!roomId) return { slangCounts: {}, topSlangs: [] }
  const file = slangFileFor(roomId)
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed.slangCounts === 'object') {
        return parsed
      }
    }
  } catch {}

  return { slangCounts: {}, topSlangs: [] }
}

function saveGroupProfile(roomId, profile) {
  const file = slangFileFor(roomId)
  const tmp = `${file}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(profile, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

/**
 * 监听群友发言并更新该群的语言特征镜像
 * @param {string} roomId 群ID
 * @param {string} text 群友发送的消息文本
 */
export function recordGroupMessage(roomId, text) {
  if (!roomId || !text || typeof text !== 'string') return
  const clean = text.trim()
  if (clean.length < 2 || clean.length > 200) return

  // 1. 扫描匹配特征俚语
  const detected = new Set()
  for (const reg of SLANG_PATTERNS) {
    const match = clean.match(reg)
    if (match) {
      detected.add(match[0])
    }
  }

  // 2. 扫描短口头禅（如 “？？？”、“！！！”、“草”、“6”）
  if (/^[？?]{2,}$/.test(clean)) detected.add('？？？')
  if (/^[！!]{2,}$/.test(clean)) detected.add('！！！')
  if (/^(草|卧槽|woc|草了)$/i.test(clean)) detected.add('草')
  if (/^6+$/.test(clean)) detected.add('6')

  if (detected.size === 0) return

  const profile = getGroupLinguisticProfile(roomId)
  profile.slangCounts = profile.slangCounts || {}

  for (const term of detected) {
    profile.slangCounts[term] = (profile.slangCounts[term] || 0) + 1
  }

  // 排序选出前 8 个最高频俚语
  profile.topSlangs = Object.entries(profile.slangCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term]) => term)

  profile.updatedAt = new Date().toISOString()
  saveGroupProfile(roomId, profile)
}

/**
 * 格式化为注入 System Prompt 的群聊语言镜像指南
 */
export function formatGroupLinguisticPrompt(roomId) {
  if (!roomId) return ''
  const profile = getGroupLinguisticProfile(roomId)
  const slangs = profile.topSlangs || []
  if (slangs.length === 0) return ''

  return `【本群专属口吻镜像（融入群友）】
本群群友日常高频口头禅有：${slangs.join('、')}。
交流时可自然带入群友的这种接话语气或偶尔使用这些口头禅，显得你跟群友是一伙的，彻底消除生硬感。`
}
