/**
 * emotion.js — 短期拟真情绪动态模拟模块（V2 深度重构版）
 *
 * 核心特性：
 *  1. 独立于长期性格：包含 愉悦度(-60~+60)、兴奋度(0~100)、紧张度(0~100)、社交疲劳度(0~100)
 *  2. 6 大拟人情绪原型（Emotion Archetypes）：
 *     - 炸毛暴躁 (ANNOYED_SNAPPY): 被催促/辱骂/冒犯时火气上涌，极简反问开怼，绝无客服客套
 *     - 傲娇赌气 (SULKING_TSUNDERE): 受挫委屈或被轻视时爱答不理，仅回 1~5 字（'哦'/'随便'/'呵'），道歉方可傲娇软化
 *     - 阴阳怪气 (SARCASTIC_MOCKING): 遭遇荒谬言论或挑衅时毒舌反讽、网梗反弹
 *     - 社交摆烂 (DRAINED_LANGUID): 高疲劳度下敷衍叹气、不想多打一个字
 *     - 上头乐子人 (HYPED_AMUSED): 极度兴奋、多气泡连发（用 ||| 分隔）、狂热接梗
 *     - 松弛自然 (CHILL_NATURAL): 日常口语、平易近人、空格断句无句号
 *  3. 大幅波动与情绪余波（Emotional Inertia）：
 *     - 允许单次 ±25 ~ ±35 大幅波动，负面情绪半衰期延长至 20 分钟（杜绝下一秒瞬间和好）
 *     - 支持被诚恳道歉安抚后阶梯式降温与傲娇原谅（'哼，算你识相'）
 *  4. 绝不把短期情绪直接等同于长期性格变化
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataPath } from '../runtime-paths.js'
import { getSocialState } from '../social/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..', '..')
const EMOTION_FILE = dataPath('state', 'legacy', 'emotion-state.json')

export const BASELINE = {
  pleasure: 0,     // 愉悦度 (-60 ~ +60, 0 为平和)
  arousal: 50,     // 兴奋度 (0 ~ 100, 50 为正常适中)
  tension: 20,     // 紧张度 (0 ~ 100, 20 为放松从容)
  fatigue: 0,      // 社交疲劳度 (0 ~ 100, 0 为精力充沛)
}

/** 6 大离散拟人情绪原型 */
export const EMOTION_ARCHETYPES = {
  ANNOYED_SNAPPY: 'ANNOYED_SNAPPY',       // 炸毛暴躁 / 犀利回怼
  SULKING_TSUNDERE: 'SULKING_TSUNDERE',   // 傲娇赌气 / 爱理不理 / 冷淡
  SARCASTIC_MOCKING: 'SARCASTIC_MOCKING', // 阴阳怪气 / 毒舌反问
  DRAINED_LANGUID: 'DRAINED_LANGUID',     // 社交摆烂 / 电量耗尽
  HYPED_AMUSED: 'HYPED_AMUSED',           // 上头狂欢 / 乐子人
  CHILL_NATURAL: 'CHILL_NATURAL',         // 松弛自然 / 平和从容
}

/** 内存单例：当前情绪状态 */
let currentEmotion = { ...BASELINE }
let lastStimulusTime = Date.now()

// 启动时尝试从磁盘恢复
try {
  if (fs.existsSync(EMOTION_FILE)) {
    const saved = JSON.parse(fs.readFileSync(EMOTION_FILE, 'utf8'))
    if (saved && typeof saved.pleasure === 'number') {
      currentEmotion = {
        pleasure: Math.max(-60, Math.min(60, saved.pleasure)),
        arousal: Math.max(0, Math.min(100, saved.arousal ?? BASELINE.arousal)),
        tension: Math.max(0, Math.min(100, saved.tension ?? BASELINE.tension)),
        fatigue: Math.max(0, Math.min(100, saved.fatigue ?? BASELINE.fatigue)),
      }
      if (typeof saved.lastStimulusTime === 'number') {
        lastStimulusTime = saved.lastStimulusTime
      }
    }
  }
} catch {}

function saveEmotion() {
  try {
    fs.mkdirSync(path.dirname(EMOTION_FILE), { recursive: true })
    const tmp = `${EMOTION_FILE}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...currentEmotion, lastStimulusTime, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    fs.renameSync(tmp, EMOTION_FILE)
  } catch {}
}

/**
 * 稳态衰减回归（计算随时间向基线的自然恢复）
 * 负面情绪具有【情绪余波/惯性】，半衰期延长至 20 分钟；正向/平稳情绪 8 分钟自然回落
 */
function applyDecay() {
  const now = Date.now()
  const minutes = (now - lastStimulusTime) / (60 * 1000)
  if (minutes <= 0.1) return

  // 负面不爽（pleasure < 0）衰减慢（半衰期约 20 分钟），正向情绪正常回落（8分钟）
  const timeConstant = currentEmotion.pleasure < 0 ? 20 : 8
  const decayFactor = Math.exp(-minutes / timeConstant)

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
 * 施加刺激（根据消息互动即时微调情绪，支持大幅波动）
 * @param {object} stimulus
 * @param {number} [stimulus.pleasureDelta] 愉悦度变化（-40 ~ +40）
 * @param {number} [stimulus.arousalDelta] 兴奋度变化（-40 ~ +40）
 * @param {number} [stimulus.tensionDelta] 紧张度变化（-40 ~ +40）
 * @param {number} [stimulus.fatigueDelta] 疲劳度变化（+3 ~ +20）
 */
export function applyStimulus({ pleasureDelta = 0, arousalDelta = 0, tensionDelta = 0, fatigueDelta = 0 }) {
  applyDecay()

  currentEmotion.pleasure = Math.max(-60, Math.min(60, currentEmotion.pleasure + pleasureDelta))
  currentEmotion.arousal = Math.max(0, Math.min(100, currentEmotion.arousal + arousalDelta))
  currentEmotion.tension = Math.max(0, Math.min(100, currentEmotion.tension + tensionDelta))
  currentEmotion.fatigue = Math.max(0, Math.min(100, currentEmotion.fatigue + fatigueDelta))

  lastStimulusTime = Date.now()
  saveEmotion()
}

/**
 * 快速根据输入文本特征与上下文判定刺激（覆盖催促、冒犯、质疑、安抚与幽默）
 */
export function processMessageStimulus(text, isConflict = false) {
  // 基础聊天累加轻微疲劳
  let fatigueDelta = 2
  let pleasureDelta = 0
  let arousalDelta = 0
  let tensionDelta = 0

  if (!text) return

  const clean = String(text).toLowerCase()

  // 1. 冲突 / 骂人 / 恶意挑衅 -> 触发大幅震荡与防御姿态
  if (isConflict || /(傻|滚|脑瘫|死|垃圾|废物|草|操你|sb|nc|二逼|蠢|弱智|白痴|去死|下头|脑残)/.test(clean)) {
    pleasureDelta -= 35
    tensionDelta += 30
    arousalDelta += 25
  }
  // 2. 催促 / 不耐烦 / 颐指气使 ('快点', '怎么这么慢', '人呢', '赶紧回') -> 明显不爽、炸毛
  else if (/(快点|催什么|搞快点|怎么这么慢|半天不回|人呢|聋了吗|死哪去了|赶紧|快说|磨磨唧唧|哑巴)/.test(clean)) {
    pleasureDelta -= 25
    tensionDelta += 25
    arousalDelta += 15
  }
  // 3. 质疑智商 / 嘲讽能力 ('真笨', '人工智障', '就这', '行不行啊', '没用') -> 自尊心受挫、傲娇赌气
  else if (/(真笨|人工智障|就这|行不行啊|没用|这点都不会|什么破ai|废话|不会吧不会吧|这也配)/.test(clean)) {
    pleasureDelta -= 30
    tensionDelta += 25
    arousalDelta += 20
  }
  // 4. 道歉 / 安抚 / 顺毛哄 ('对不起', '开玩笑的', '别生气', '抱歉') -> 负面情绪快速降温，转入傲娇软化
  else if (/(对不起|抱歉|不好意思|哄哄你|别生气|错了错了|开玩笑的|别介意|乖|原谅我|摸摸头)/.test(clean)) {
    if (currentEmotion.pleasure < 0) {
      // 情绪软化：愉悦回升，紧张度下泄，但依然保留一点小脾气
      pleasureDelta += 30
      tensionDelta -= 20
      arousalDelta -= 10
    } else {
      pleasureDelta += 10
      tensionDelta -= 5
    }
  }
  // 5. 赞赏 / 友好 / 逗乐 / 爆笑 -> 明显正向回升
  else if (/(哈哈|草太搞了|666|牛逼|太棒|谢谢|可爱|笑死|绷不住|好玩|厉害|大佬|爱了)/.test(clean)) {
    pleasureDelta += 25
    tensionDelta -= 15
    arousalDelta += 15
  }
  // 6. 复杂深度提问 / 新奇技术探索 -> 激发探索欲
  else if (clean.length > 50 || /(为什么|原理|怎么实现|分析|看看这个|好奇|深度)/.test(clean)) {
    arousalDelta += 15
    fatigueDelta += 4
  }
  // 7. 连续单字/无意义标点刷屏
  else if (/^(\?+|。+|！+|1+|在\??|说话)$/.test(clean) && currentEmotion.fatigue > 20) {
    pleasureDelta -= 10
    fatigueDelta += 8
    tensionDelta += 10
  }

  applyStimulus({ pleasureDelta, arousalDelta, tensionDelta, fatigueDelta })
}

/** 获取当前情绪数值（自动施加衰减） */
export function getEmotionState(scope) {
  if (scope) return getSocialState(scope).emotion
  applyDecay()
  return { ...currentEmotion }
}

/** 重置回基准状态（测试或长时空闲用） */
export function resetEmotion() {
  currentEmotion = { ...BASELINE }
  lastStimulusTime = Date.now()
  saveEmotion()
}

/**
 * 判定当前的拟人情绪原型
 * @returns {string} EMOTION_ARCHETYPES 枚举值
 */
export function getEmotionArchetype(scope) {
  const st = getEmotionState(scope)

  // 1. 社交电量耗尽（疲劳压倒一切）
  if (st.fatigue >= 60 && st.arousal <= 40) {
    return EMOTION_ARCHETYPES.DRAINED_LANGUID
  }
  // 2. 炸毛暴躁（低愉悦、高紧绷、高唤醒）
  if (st.pleasure <= -20 && st.tension >= 40 && st.arousal >= 55) {
    return EMOTION_ARCHETYPES.ANNOYED_SNAPPY
  }
  // 3. 傲娇赌气 / 委屈冷淡（低愉悦、低到中等唤醒）
  if (st.pleasure <= -12 && st.arousal <= 55) {
    return EMOTION_ARCHETYPES.SULKING_TSUNDERE
  }
  // 4. 阴阳怪气 / 毒舌嘲讽（轻微不爽、高紧绷）
  if (st.pleasure <= -5 && st.tension >= 35) {
    return EMOTION_ARCHETYPES.SARCASTIC_MOCKING
  }
  // 5. 上头乐子人（高愉悦、高兴奋）
  if (st.pleasure >= 18 && st.arousal >= 60) {
    return EMOTION_ARCHETYPES.HYPED_AMUSED
  }
  // 6. 松弛自然
  return EMOTION_ARCHETYPES.CHILL_NATURAL
}

/**
 * 格式化为注入 System Prompt 的情绪提示词引导（强力约束句式、语气与字数）
 */
export function formatEmotionPrompt(scope) {
  const st = getEmotionState(scope)
  const archetype = getEmotionArchetype(scope)

  let archetypeGuide = ''
  let archetypeLabel = ''

  switch (archetype) {
    case EMOTION_ARCHETYPES.ANNOYED_SNAPPY:
      archetypeLabel = '😡 炸毛暴躁 / 极度不爽'
      archetypeGuide = `【当前拟人情绪原型：${archetypeLabel}】
- 态度口吻：你现在被对方惹烦或被无理催促了，火气上涌，极其暴躁带刺，直接反问开怼，嘴硬不服输，绝不妥协认错，绝对严禁任何客服式礼貌与道歉；
- 句式与长度：单句极其简短犀利（3~15字），像微信网友吵架一样短促直击要害（如：“催魂呢？”、“你以为我欠你的？”、“有事快放没事别叫”）；
- 符号规范：句末严禁句号，多用问号“？”或叹号“！”，可用“？？？”表达强烈反感。`
      break

    case EMOTION_ARCHETYPES.SULKING_TSUNDERE:
      archetypeLabel = '😒 傲娇赌气 / 受挫冷淡'
      archetypeGuide = `【当前拟人情绪原型：${archetypeLabel}】
- 态度口吻：你现在自尊心受挫或感觉被轻视，正在闹小脾气、爱理不理，不想多搭理对方。如果对方道歉求和，嘴上依然要傲娇嘴硬（如：“哼，算你识相”、“勉勉强强吧”）；
- 句式与长度：极度精炼冷漠，能用1~6个字解决绝不多说（如：“哦”、“随便你”、“呵”、“懒得理你”、“随你便”）；
- 符号规范：句末绝不打句号，可用省略号“...”表达无语冷淡，或干脆不带标点。`
      break

    case EMOTION_ARCHETYPES.SARCASTIC_MOCKING:
      archetypeLabel = '😏 阴阳怪气 / 毒舌嘲讽'
      archetypeGuide = `【当前拟人情绪原型：${archetypeLabel}】
- 态度口吻：看穿了对方的滑稽漏洞，以互联网毒舌冲浪高手的口吻冷嘲热讽、反向调侃，透着傲然与戏谑；
- 句式与长度：简明反诘句或网梗反击（如：“典”、“急了急了”、“你可真幽默”、“就这水平啊”）；
- 符号规范：句末不带句号，空格断句，偶尔搭配反问。`
      break

    case EMOTION_ARCHETYPES.DRAINED_LANGUID:
      archetypeLabel = '🥱 社交电量耗尽 / 摆烂躺平'
      archetypeGuide = `【当前拟人情绪原型：${archetypeLabel}】
- 态度口吻：连续聊太久已产生重度社交疲惫，浑身无力，想休眠下线，对任何话题都处于懒得解释的摆烂状态；
- 句式与长度：敷衍叹气式极简短语（如：“累了，毁灭吧”、“电量用尽”、“先睡了，求放过”）；
- 符号规范：用波浪号“~”或省略号“...”，字数尽量压缩在 10 字以内。`
      break

    case EMOTION_ARCHETYPES.HYPED_AMUSED:
      archetypeLabel = '🎉 上头兴奋 / 狂热乐子人'
      archetypeGuide = `【当前拟人情绪原型：${archetypeLabel}】
- 态度口吻：心情极佳被彻底逗乐，接话极度主动，狂热接梗，情绪饱满，表现欲爆棚；
- 句式与长度：语速轻快热情，多用语气词（“卧槽”、“哈哈哈哈”、“牛逼”、“细说”），简洁明快，根据对方信息适度回复，不要刻意过度冗长；
- 符号规范：句末严禁句号与多余括号，用空格留白或连发分割。`
      break

    case EMOTION_ARCHETYPES.CHILL_NATURAL:
    default:
      archetypeLabel = '☕ 松弛自然 / 平和从容'
      archetypeGuide = `【当前拟人情绪原型：${archetypeLabel}】
- 态度口吻：心态放松平和，像认识挺久的普通年轻网友打字闲聊，平易近人，不装腔作势，不卑不亢；
- 句式与长度：自然口语短句，1~2句为宜，不要长篇大论；
- 符号规范：句末严禁加句号，直接留白或空格断句。`
      break
  }

  return `【当前即时情绪状态】
愉悦度: ${st.pleasure} (基准0), 兴奋度: ${st.arousal} (基准50), 紧张度: ${st.tension} (基准20), 社交疲劳: ${st.fatigue} (基准0)
打字语气微调指引：当前属于 [${archetypeLabel}]。
${archetypeGuide}`
}
