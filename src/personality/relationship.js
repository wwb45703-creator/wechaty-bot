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
 * 计算洋葱模型复合熟悉度 (Social Penetration Familiarity Index)
 * 复合维度：
 *  - 交互频次 (40% 权重，上限 40 分): 对数边际递减
 *  - 话题广度 (30% 权重，上限 30 分): 覆盖的多元话题数量
 *  - 经历深度 (30% 权重，上限 30 分): 沉淀的重要共同经历与情景记忆
 */
export function calculateSocialPenetrationFamiliarity(interactionCount, topicsCount, experiencesCount) {
  // 1. 频次分 (0 ~ 40, 严格限制上限 40 分，防止纯刷频次突破熟人门槛)
  const count = Math.max(0, interactionCount || 0)
  const freqScore = count === 0 ? 5 : Math.min(40, 40 * (Math.log(1 + 0.1 * count) / Math.log(1 + 0.1 * 60)))

  // 2. 话题广度分 (0 ~ 30, 聊过4个以上不同领域话题达到满额)
  const breadthScore = 30 * Math.min(1.0, Math.max(0, topicsCount || 0) / 4)

  // 3. 经历深度分 (0 ~ 30, 沉淀3个及以上关键情景记忆达到满额)
  const depthScore = 30 * Math.min(1.0, Math.max(0, experiencesCount || 0) / 3)

  const raw = freqScore + breadthScore + depthScore
  return Math.round(Math.max(5, Math.min(100, raw)) * 10) / 10
}

/**
 * 艾宾浩斯式关系时间衰减与锚点保护
 * 长期不联系熟悉度自然生疏，但历史深度经历提供永久锚点硬底保护
 */
export function applyRelationshipDecay(rel) {
  if (!rel || !rel.lastInteractedAt) return rel

  try {
    const last = new Date(rel.lastInteractedAt).getTime()
    const now = Date.now()
    const idleDays = (now - last) / (1000 * 60 * 60 * 24)

    // 超过 14 天未联系开始缓慢时间衰减
    if (idleDays > 14) {
      const decayFactor = Math.exp(-(idleDays - 14) / 45) // 45天半衰期
      // 锚点保底线：每个重要经历提供 15 分永久记忆锚点，最高保底 50 分
      const expCount = (rel.sharedExperiences || []).length
      const anchorFloor = Math.min(50, 5 + 15 * expCount)

      const decayedFam = rel.familiarity * decayFactor
      rel.familiarity = Math.round(Math.max(anchorFloor, decayedFam) * 10) / 10
    }
  } catch {}

  return rel
}

/**
 * 加载特定成员的关系档案（自动施加时间衰减检测）
 */
export function getRelationship(userId, displayName = '') {
  if (!userId) {
    return {
      userId: 'unknown',
      displayName: displayName || '未知群友',
      familiarity: 5,
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
      applyRelationshipDecay(data)
      return data
    }
  } catch {}

  // 初始档案（新群友：处于表层定向阶段）
  return {
    userId,
    displayName: displayName || '',
    familiarity: 5,     // 初始熟悉度 5
    trust: 40,          // 初始继承适度谨慎信任基准 40
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
 * 记录一次与成员的真实交互，推进关系进展（洋葱模型与损失厌恶）
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

  // 1. 话题累积
  if (topic && topic.length >= 2 && topic.length <= 15) {
    if (!rel.sharedTopics.includes(topic)) {
      rel.sharedTopics.push(topic)
      if (rel.sharedTopics.length > 10) rel.sharedTopics.shift()
    }
  }

  // 2. 重要经历绑定
  if (episodeId && !rel.sharedExperiences.includes(episodeId)) {
    rel.sharedExperiences.push(episodeId)
    if (rel.sharedExperiences.length > 10) rel.sharedExperiences.shift()
  }

  // 3. 社会渗透洋葱模型：综合频次、话题广度、经历深度重估熟悉度
  rel.familiarity = calculateSocialPenetrationFamiliarity(
    rel.interactionCount,
    rel.sharedTopics.length,
    rel.sharedExperiences.length
  )

  // 4. 信任度动态演化：边际递减正向积累 vs 心理学损失厌恶 (Loss Aversion, 2.2x)
  if (sentiment === 'positive') {
    // 边际建立递减：信任越深，进一步提升越需要更长久的考验
    const headroomFactor = Math.max(0.2, (100 - rel.trust) / 60)
    const gain = 0.8 * headroomFactor
    rel.trust = Math.round(Math.min(95, rel.trust + gain) * 10) / 10
  } else if (sentiment === 'negative') {
    // 心理学损失厌恶惩罚：原先越信任，遭遇负向行为打击感越大
    const lossAversionMultiplier = 2.2 * (1 + rel.trust / 100)
    const loss = 0.8 * lossAversionMultiplier
    rel.trust = Math.round(Math.max(10, rel.trust - loss) * 10) / 10
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
 * 格式化为注入 System Prompt 的人际关系指南（社会渗透四阶段模型）
 */
export function formatRelationshipPrompt(userId, displayName = '') {
  if (!userId) return ''
  const rel = getRelationship(userId, displayName)

  let stage = ''
  let toneAdvice = ''

  if (rel.familiarity >= 80) {
    stage = '【核心默契阶段】'
    toneAdvice = '彼此非常熟悉和信赖的核心老友：沟通毫无隔阂，可直率调侃、深度共鸣与彼此托付，说话最随意自在。'
  } else if (rel.familiarity >= 55) {
    stage = '【真诚情感阶段】'
    toneAdvice = '常聊且聊得来的老熟人：交流放松自然，多用口语化语气，无需客套生分。'
  } else if (rel.familiarity >= 25) {
    stage = '【探索交友阶段】'
    toneAdvice = '有过几次交集的群友：态度友好平和，自然接梗，逐步探索共同话题。'
  } else {
    stage = '【表层定向阶段】'
    toneAdvice = '新面孔或极少交流的群友：保持礼貌与分寸感，态度温和但不过度热情或随意造次。'
  }

  const topicsDesc = rel.sharedTopics.length > 0 ? rel.sharedTopics.join('、') : '暂无明显共同话题'

  return `【与当前发言者的关系】
目标群友：${rel.displayName || rel.userId}
熟悉度: ${rel.familiarity}/100, 信任度: ${rel.trust}/100, 历史互动轮数: ${rel.interactionCount} 次
共同交流过的话题: ${topicsDesc}
交谈风格建议：${toneAdvice}`
}
