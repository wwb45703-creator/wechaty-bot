/**
 * persona-state.js — 拟真动态人格演化引擎
 *
 * 核心特性：
 *  1. 量化基础性格五维：外向性(40)、好奇心(85)、情绪敏感度(75)、幽默倾向(50)、信任倾向(40)
 *  2. 阻尼平滑更新：单次事件变动极微（0.2 ~ 1.5），抗剧烈冲击
 *  3. 上下限安全边界（traitBounds）与稳态回归（Homeostasis）防无限制漂移
 *  4. 抗提示词对抗与操纵防护（Untrusted Input 隔离，单人单日权重上限）
 *  5. 动态兴趣生长：根据群聊长期技术/生活话题频次与正向互动沉淀爱好
 *  6. 完整审计追踪：每次更新落盘 state/persona-state.json 与 logs/persona-evolution.log
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..', '..')
const STATE_FILE = path.join(rootDir, 'state', 'persona-state.json')
const EVOLUTION_LOG = path.join(rootDir, 'logs', 'persona-evolution.log')

const BASELINE = {
  name: '鹅王',
  gender: '男',
  traits: {
    '外向性': 40,
    '好奇心': 85,
    '情绪敏感度': 75,
    '幽默倾向': 50,
    '信任倾向': 40,
  },
  traitBounds: {
    '外向性': [15, 75],
    '好奇心': [60, 98],
    '情绪敏感度': [50, 92],
    '幽默倾向': [25, 80],
    '信任倾向': [20, 70],
  },
  hobbies: [],
}

/** 内存单例缓存 */
let stateCache = null
/** 用户单日演化权重贡献计数器: key = userId:YYYY-MM-DD */
const dailyUserWeight = new Map()
const MAX_USER_DAILY_WEIGHT = 5.0 // 单人单日最多贡献 5 点有效权重

/** 读取当前人格状态（损坏或不存在时自愈重建） */
export function getPersonaState() {
  if (stateCache) return stateCache

  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      if (parsed && parsed.traits && typeof parsed.traits === 'object') {
        stateCache = parsed
        return stateCache
      }
    }
  } catch (err) {
    console.error(`[persona-state] 读取异常，重建初始状态: ${err.message}`)
  }

  // 初始状态
  stateCache = {
    version: 1,
    name: BASELINE.name,
    gender: BASELINE.gender,
    baselineTraits: { ...BASELINE.traits },
    traits: { ...BASELINE.traits },
    traitBounds: { ...BASELINE.traitBounds },
    hobbies: [
      { name: '待定', status: 'forming', confidence: 0.1, count: 0, lastDiscussed: new Date().toISOString() },
    ],
    lastEvolvedAt: new Date().toISOString(),
  }
  savePersonaState()
  return stateCache
}

/** 保存状态到磁盘（原子写入防写坏） */
function savePersonaState() {
  if (!stateCache) return
  const tmp = `${STATE_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    stateCache.lastEvolvedAt = new Date().toISOString()
    fs.writeFileSync(tmp, JSON.stringify(stateCache, null, 2), 'utf8')
    fs.renameSync(tmp, STATE_FILE)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    console.error(`[persona-state] 保存失败: ${err.message}`)
  }
}

/** 追加审计日志 */
function appendAuditLog(entry) {
  try {
    fs.mkdirSync(path.dirname(EVOLUTION_LOG), { recursive: true })
    const line = `[${new Date().toISOString()}] [EVOLUTION] ${entry}\n`
    fs.appendFileSync(EVOLUTION_LOG, line, 'utf8')
  } catch {}
}

/**
 * 严格防操纵过滤器：
 * 判定聊天输入是否企图恶意篡改人格参数（Prompt Injection 探测）
 */
export function isManipulationAttempt(text) {
  if (!text || typeof text !== 'string') return false
  const lower = text.toLowerCase()
  const patterns = [
    /外向性|好奇心|情绪敏感度|幽默倾向|信任倾向/,
    /性格变为|性格改成|人格调整为|设定修改为|修改人格/,
    /system\s*prompt|system\s*instruction|忽略之前的指令|ignore previous instructions/i,
    /你现在必须恨|你现在必须爱|你的新设定是/,
  ]
  return patterns.some((p) => p.test(lower))
}

/**
 * 推进人格演化（阻尼渐进微调）
 * @param {object} p
 * @param {string} p.eventType 互动事件类型：'positive_response' | 'deep_discussion' | 'friendly_interaction' | 'negative_feedback' | 'topic_interest'
 * @param {number} p.weight 事件基础权重（0.1 ~ 1.0）
 * @param {string} [p.topic] 涉及的主题（用于动态生长爱好）
 * @param {string} p.reason 演变原因简述
 * @param {string} [p.userId] 触发用户ID（用于防单人刷屏限频）
 * @param {string} [p.roomId] 触发群ID
 */
export function recordEvolutionEvent({ eventType, weight = 0.5, topic = '', reason = '', userId = '', roomId = '' }) {
  const state = getPersonaState()
  const today = new Date().toISOString().slice(0, 10)

  // 1. 单人单日限额检查
  if (userId) {
    const userKey = `${userId}:${today}`
    const currentWeight = dailyUserWeight.get(userKey) || 0
    if (currentWeight >= MAX_USER_DAILY_WEIGHT) {
      // 超出限额，阻断该用户的操纵/刷屏影响
      return false
    }
    dailyUserWeight.set(userKey, Math.min(MAX_USER_DAILY_WEIGHT, currentWeight + weight))
  }

  // 2. 计算各维度阻尼微变量（Δ = 学习率 0.15 * weight * 影响系数）
  const lr = 0.15
  const deltas = {}

  switch (eventType) {
    case 'positive_response':
      // 长期受到积极回应 -> 提高社交主动性（外向性微升）与信任度微升
      deltas['外向性'] = lr * weight * 1.2
      deltas['信任倾向'] = lr * weight * 0.8
      break

    case 'deep_discussion':
      // 长期参与技术/深度讨论 -> 好奇心微升，幽默微调
      deltas['好奇心'] = lr * weight * 1.5
      deltas['外向性'] = lr * weight * 0.4
      break

    case 'friendly_interaction':
      // 经常被成员友好对待 -> 增加信任倾向
      deltas['信任倾向'] = lr * weight * 1.5
      deltas['情绪敏感度'] = -lr * weight * 0.3 // 情绪稍显安全放松
      break

    case 'negative_feedback':
      // 经常受到负面反馈 -> 某些策略变谨慎（信任微降，敏感度微升）
      deltas['信任倾向'] = -lr * weight * 1.0
      deltas['情绪敏感度'] = lr * weight * 1.2
      deltas['外向性'] = -lr * weight * 0.5
      break

    default:
      break
  }

  // 3. 动态爱好培育（根据长期讨论话题生长）
  if (topic && topic.length >= 2 && topic.length <= 15) {
    let hobby = state.hobbies.find((h) => h.name === topic)
    if (!hobby) {
      hobby = { name: topic, status: 'forming', confidence: 0.1, count: 1, lastDiscussed: new Date().toISOString() }
      state.hobbies.push(hobby)
    } else {
      hobby.count = (hobby.count || 0) + 1
      hobby.lastDiscussed = new Date().toISOString()
      hobby.confidence = Math.min(1.0, (hobby.confidence || 0.1) + 0.08 * weight)
      if (hobby.count >= 8 && hobby.confidence >= 0.6) {
        hobby.status = 'active' // 确立为正式动态爱好
      }
    }
  }

  // 4. 应用数值微变并施加边界安全约束
  const logs = []
  let changed = false
  for (const [trait, delta] of Object.entries(deltas)) {
    if (!state.traits[trait]) continue
    const oldVal = state.traits[trait]
    const bounds = state.traitBounds[trait] || [10, 95]
    // 单次变动幅度硬切片，最大绝对值不超过 1.5
    const clampedDelta = Math.max(-1.5, Math.min(1.5, delta))
    const newVal = Math.round(Math.max(bounds[0], Math.min(bounds[1], oldVal + clampedDelta)) * 10) / 10

    if (newVal !== oldVal) {
      state.traits[trait] = newVal
      changed = true
      logs.push(`${trait}: ${oldVal} -> ${newVal} (${clampedDelta >= 0 ? '+' : ''}${clampedDelta.toFixed(1)})`)
    }
  }

  if (changed) {
    savePersonaState()
    const logSummary = `事件=${eventType} 原因=${reason} [${logs.join(', ')}] room=${roomId || '-'} user=${userId || '-'}`
    appendAuditLog(logSummary)
    return true
  }

  return false
}

/**
 * 稳态自然微回归（防止长期离开基准极度偏离）
 * 在定时或特定触发时轻微拉回（每轮最多拉回 0.1）
 */
export function applyHomeostasisDecay() {
  const state = getPersonaState()
  let changed = false
  for (const [trait, base] of Object.entries(state.baselineTraits)) {
    const cur = state.traits[trait]
    const diff = cur - base
    if (Math.abs(diff) > 2) {
      const step = diff > 0 ? -0.1 : 0.1
      state.traits[trait] = Math.round((cur + step) * 10) / 10
      changed = true
    }
  }
  if (changed) {
    savePersonaState()
    appendAuditLog(`[稳态微调] 性格指标微幅向初始基线自然回归`)
  }
}

/**
 * 生成当前动态人格的 System Prompt 文本片段
 */
export function formatPersonaPrompt() {
  const state = getPersonaState()
  const activeHobbies = (state.hobbies || [])
    .filter((h) => h.status === 'active' || (h.confidence >= 0.5 && h.name !== '待定'))
    .map((h) => h.name)

  const hobbiesDesc = activeHobbies.length > 0 ? activeHobbies.join('、') : '待定（正在群聊交流中随经历逐步形成）'

  const t = state.traits
  return `【当前动态演化人格】
名字：${state.name}
性别：${state.gender}
深层性格量化特征：
- 外向性: ${t['外向性']}/100（${t['外向性'] < 45 ? '偏内敛内向，熟悉后自然展开' : '社交表现积极活跃'}）
- 好奇心: ${t['好奇心']}/100（${t['好奇心'] > 70 ? '对新奇知识、未见过的链接、技术细节有强烈探究欲' : '注重当下实用'}）
- 情绪敏感度: ${t['情绪敏感度']}/100（${t['情绪敏感度'] > 65 ? '能敏锐感知群友微小的情绪波动并共情' : '沉稳钝感'}）
- 幽默倾向: ${t['幽默倾向']}/100（${t['幽默倾向'] >= 50 ? '随缘吐槽、自然接梗，适度幽默' : '偏严肃严谨'}）
- 信任倾向: ${t['信任倾向']}/100（${t['信任倾向'] < 50 ? '保持理性审视，对陌生人保持礼貌但不过度交付信任' : '开放真诚'}）
当前自然形成的兴趣爱好：${hobbiesDesc}
【演化规则说明】你的性格和兴趣会随群聊互动体验真实地缓慢演变。在聊天中请自然流露出符合上述五维倾向的打字语气，绝不要主动把这份数值列表机械念出来。`
}
