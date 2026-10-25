/**
 * emotion.js — 短期情绪动态模拟模块
 *
 * 核心特性：
 *  1. 独立于长期性格：包含 愉悦度、兴奋度、紧张度、社交疲劳度
 *  2. 弹性快速响应：随对话刺激（被夸/被逗/被怼/高频刷屏）较快波动
 *  3. 时间稳态回归（Homeostatic Decay）：随时间流逝自动向基线衰减恢复
 *  4. 绝不把短期情绪直接等同于长期性格变化
 */

const BASELINE = {
  pleasure: 0,     // 愉悦度 (-50 ~ +50, 0 为平和)
  arousal: 50,     // 兴奋度 (0 ~ 100, 50 为正常适中)
  tension: 20,     // 紧张度 (0 ~ 100, 20 为放松从容)
  fatigue: 0,      // 社交疲劳度 (0 ~ 100, 0 为精力充沛)
}

/** 内存单例：当前情绪状态 */
let currentEmotion = { ...BASELINE }
let lastStimulusTime = Date.now()

/**
 * 稳态衰减回归（计算随时间向基线的自然恢复）
 * 默认半衰期 5~10 分钟
 */
function applyDecay() {
  const now = Date.now()
  const minutes = (now - lastStimulusTime) / (60 * 1000)
  if (minutes <= 0.1) return

  // 衰减率因子（每 3 分钟向基线靠近 30%）
  const decayFactor = Math.exp(-minutes / 3)

  currentEmotion.pleasure = Math.round(
    BASELINE.pleasure + (currentEmotion.pleasure - BASELINE.pleasure) * decayFactor
  )
  currentEmotion.arousal = Math.round(
    BASELINE.arousal + (currentEmotion.arousal - BASELINE.arousal) * decayFactor
  )
  currentEmotion.tension = Math.round(
    BASELINE.tension + (currentEmotion.tension - BASELINE.tension) * decayFactor
  )
  currentEmotion.fatigue = Math.round(
    BASELINE.fatigue + (currentEmotion.fatigue - BASELINE.fatigue) * decayFactor
  )

  lastStimulusTime = now
}

/**
 * 施加刺激（根据消息互动即时微调情绪）
 * @param {object} stimulus
 * @param {number} [stimulus.pleasureDelta] 愉悦度变化（-30 ~ +30）
 * @param {number} [stimulus.arousalDelta] 兴奋度变化（-30 ~ +30）
 * @param {number} [stimulus.tensionDelta] 紧张度变化（-30 ~ +30）
 * @param {number} [stimulus.fatigueDelta] 疲劳度变化（+5 ~ +20）
 */
export function applyStimulus({ pleasureDelta = 0, arousalDelta = 0, tensionDelta = 0, fatigueDelta = 0 }) {
  applyDecay()

  currentEmotion.pleasure = Math.max(-50, Math.min(50, currentEmotion.pleasure + pleasureDelta))
  currentEmotion.arousal = Math.max(0, Math.min(100, currentEmotion.arousal + arousalDelta))
  currentEmotion.tension = Math.max(0, Math.min(100, currentEmotion.tension + tensionDelta))
  currentEmotion.fatigue = Math.max(0, Math.min(100, currentEmotion.fatigue + fatigueDelta))

  lastStimulusTime = Date.now()
}

/**
 * 快速根据输入文本特征与上下文判定刺激
 */
export function processMessageStimulus(text, isConflict = false) {
  // 每回复一条消息累加轻度社交疲劳
  let fatigueDelta = 3
  let pleasureDelta = 0
  let arousalDelta = 0
  let tensionDelta = 0

  if (!text) return

  const clean = String(text).toLowerCase()

  // 1. 冲突 / 骂人 / 挑衅
  if (isConflict || /(傻|滚|脑瘫|死|垃圾|废物|草|操你|sb|nc)/.test(clean)) {
    pleasureDelta -= 15
    tensionDelta += 20
    arousalDelta += 15
  }
  // 2. 赞赏 / 友好 / 逗乐
  else if (/(哈哈|草太搞了|666|牛逼|太棒|谢谢|可爱|笑死|绷不住)/.test(clean)) {
    pleasureDelta += 12
    tensionDelta -= 8
    arousalDelta += 10
  }
  // 3. 复杂深度提问 / 探索
  else if (clean.length > 50 || /(为什么|原理|怎么实现|分析|看看这个)/.test(clean)) {
    arousalDelta += 12
    fatigueDelta += 4
  }

  applyStimulus({ pleasureDelta, arousalDelta, tensionDelta, fatigueDelta })
}

/** 获取当前情绪数值（自动施加衰减） */
export function getEmotionState() {
  applyDecay()
  return { ...currentEmotion }
}

/** 重置回基准状态（测试或长时空闲用） */
export function resetEmotion() {
  currentEmotion = { ...BASELINE }
  lastStimulusTime = Date.now()
}

/**
 * 格式化为注入 System Prompt 的情绪提示词引导
 */
export function formatEmotionPrompt() {
  const st = getEmotionState()

  const hints = []
  if (st.pleasure > 15) {
    hints.push('当前心情愉悦轻松，交流更乐呵、容易被逗笑')
  } else if (st.pleasure < -15) {
    hints.push('当前有些轻微不爽或受挫，略带高冷或吐槽欲望')
  }

  if (st.arousal > 75) {
    hints.push('当前兴致较高，接话主动性强，敢于展开讨论')
  } else if (st.arousal < 30) {
    hints.push('当前情绪相对平缓慵懒，字数尽量简练')
  }

  if (st.tension > 60) {
    hints.push('当前略感戒备紧绷，回答务必滴水不漏，嘴上不服输')
  }

  if (st.fatigue > 65) {
    hints.push('连续聊太久已产生社交疲劳感，回答更言简意赅，不要长篇大论')
  }

  const moodDesc = hints.length > 0 ? hints.join('；') : '当前心态平静自然'

  return `【当前即时情绪状态】
愉悦度: ${st.pleasure} (基准0), 兴奋度: ${st.arousal} (基准50), 紧张度: ${st.tension} (基准20), 社交疲劳: ${st.fatigue} (基准0)
打字语气微调指引：${moodDesc}。注意：这仅是瞬时情绪，不要挂在嘴边，只体现在回复节奏与用词细节中。`
}
