/**
 * relationship.js — 群成员独立人际关系网络模块
 *
 * 核心特性：
 *  1. 成员独立画像：每位成员独立维护 熟悉度、信任度、互动频率、共同话题、共同经历
 *  2. 差异化交往策略：熟人更随意亲切，新成员相对礼貌谨慎
 *  3. 真实经历可溯：共同经历必须关联真实情景记忆 ID，绝不凭空捏造
 *  4. 存储路径：state/relationships/<userId>.json
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..', '..')
const REL_DIR = path.join(rootDir, 'state', 'relationships')

function sanitizeId(id) {
  return String(id || '').replace(/[^\w\-@.]/g, '_')
}

function relFileFor(userId) {
  return path.join(REL_DIR, `${sanitizeId(userId)}.json`)
}

/**
 * 加载特定成员的关系档案
 */
export function getRelationship(userId, displayName = '') {
  if (!userId) {
    return {
      userId: 'unknown',
      displayName: displayName || '未知群友',
      familiarity: 0,
      trust: 40,
      interactionCount: 0,
      lastInteractedAt: new Date().toISOString(),
      sharedTopics: [],
      sharedExperiences: [],
    }
  }

  const file = relFileFor(userId)
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (displayName && displayName !== data.displayName) {
        data.displayName = displayName
      }
      return data
    }
  } catch {}

  // 初始档案（新群友）
  return {
    userId,
    displayName: displayName || '',
    familiarity: 5,     // 初始熟悉度低
    trust: 40,          // 初始继承基础信任度
    interactionCount: 0,
    lastInteractedAt: new Date().toISOString(),
    sharedTopics: [],
    sharedExperiences: [],
  }
}

/**
 * 保存关系档案（原子保存）
 */
function saveRelationship(userId, data) {
  const file = relFileFor(userId)
  const tmp = `${file}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

/**
 * 记录一次与成员的真实交互，推进关系进展
 * @param {object} p
 * @param {string} p.userId
 * @param {string} [p.displayName]
 * @param {string} [p.topic] 本次讨论的话题
 * @param {string} [p.sentiment] 情感倾向：'positive' | 'neutral' | 'negative'
 * @param {string} [p.episodeId] 产生的重要情景记忆ID
 */
export function recordMemberInteraction({ userId, displayName = '', topic = '', sentiment = 'neutral', episodeId = '' }) {
  if (!userId) return

  const rel = getRelationship(userId, displayName)
  rel.interactionCount = (rel.interactionCount || 0) + 1
  rel.lastInteractedAt = new Date().toISOString()

  // 1. 熟悉度自然微增（对数收益曲线，最高 100）
  // 前期增长较快，后期需要长期共同交流
  const famDelta = Math.max(0.2, 3 / Math.sqrt(rel.interactionCount + 1))
  rel.familiarity = Math.round(Math.min(100, rel.familiarity + famDelta) * 10) / 10

  // 2. 信任度微调
  if (sentiment === 'positive') {
    rel.trust = Math.round(Math.min(95, rel.trust + 0.8) * 10) / 10
  } else if (sentiment === 'negative') {
    rel.trust = Math.round(Math.max(10, rel.trust - 1.2) * 10) / 10
  }

  // 3. 共同话题沉淀
  if (topic && topic.length >= 2 && topic.length <= 15) {
    if (!rel.sharedTopics.includes(topic)) {
      rel.sharedTopics.push(topic)
      if (rel.sharedTopics.length > 10) rel.sharedTopics.shift()
    }
  }

  // 4. 重要共同经历绑定
  if (episodeId && !rel.sharedExperiences.includes(episodeId)) {
    rel.sharedExperiences.push(episodeId)
    if (rel.sharedExperiences.length > 10) rel.sharedExperiences.shift()
  }

  saveRelationship(userId, rel)
  return rel
}

/**
 * 删除某个成员的关系档案（隐私删除）
 */
export function clearRelationship(userId) {
  if (!userId) return false
  const file = relFileFor(userId)
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
      return true
    }
  } catch {}
  return false
}

/**
 * 格式化为注入 System Prompt 的人际关系指南
 */
export function formatRelationshipPrompt(userId, displayName = '') {
  if (!userId) return ''
  const rel = getRelationship(userId, displayName)

  let toneAdvice = ''
  if (rel.familiarity >= 60) {
    toneAdvice = '这是常聊的老熟人了：交流非常随意放松，多用口语与调侃，无需生分客套。'
  } else if (rel.familiarity >= 25) {
    toneAdvice = '这是有过几次交流的群友：自然接梗，态度友好平和。'
  } else {
    toneAdvice = '这是一位新面孔或极少交流的群友：保持礼貌与分寸感，态度温和但不过度热情或随意造次。'
  }

  const topicsDesc = rel.sharedTopics.length > 0 ? rel.sharedTopics.join('、') : '暂无明显共同话题'

  return `【与当前发言者的关系】
目标群友：${rel.displayName || rel.userId}
熟悉度: ${rel.familiarity}/100, 信任度: ${rel.trust}/100, 历史互动轮数: ${rel.interactionCount} 次
共同交流过的话题: ${topicsDesc}
交谈风格建议：${toneAdvice}`
}
