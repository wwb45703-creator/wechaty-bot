/**
 * test-emotion-v2.mjs — 拟真人格大跨度情绪波动与 6 大情绪原型专项测试
 *
 * 测试目标：
 *  1. 初始情绪基准校验 (PAD + Fatigue)
 *  2. 大幅负面情绪下挫验证（催促、辱骂、能力质疑）
 *  3. 6 大拟人情绪原型 (Emotion Archetypes) 精准识别
 *  4. 负面情绪余波与 20 分钟半衰期抗快速回退机制
 *  5. 道歉安抚与傲娇软化自愈机制
 *  6. System Prompt 句式、语气与字数强约束注入校验
 */

import {
  getEmotionState,
  getEmotionArchetype,
  processMessageStimulus,
  applyStimulus,
  resetEmotion,
  formatEmotionPrompt,
  EMOTION_ARCHETYPES,
  BASELINE,
} from '../src/personality/emotion.js'

let totalPass = 0
let totalFail = 0

function ok(desc, cond) {
  if (cond) {
    totalPass++
    console.log(`✅ PASS  ${desc}`)
  } else {
    totalFail++
    console.error(`❌ FAIL  ${desc}`)
  }
}

console.log('==================================================')
console.log('  拟真大跨度情绪动态与负面情绪原型专项测试')
console.log('==================================================')

// 1. 基准状态测试
resetEmotion()
const st0 = getEmotionState()
ok('初始情绪位于基准', st0.pleasure === 0 && st0.arousal === 50 && st0.tension === 20 && st0.fatigue === 0)
ok('初始情绪原型为松弛自然', getEmotionArchetype() === EMOTION_ARCHETYPES.CHILL_NATURAL)

// 2. 负面情绪大幅波动测试：催促与不耐烦
resetEmotion()
processMessageStimulus('快点回我，怎么这么慢？半天不说话聋了吗？', false)
const stRush = getEmotionState()
ok('催促消息导致愉悦度大幅下挫 (<= -20)', stRush.pleasure <= -20)
ok('催促消息导致紧张度明显上升 (>= 40)', stRush.tension >= 40)
const archRush = getEmotionArchetype()
ok('催促触发炸毛暴躁或傲娇原型', archRush === EMOTION_ARCHETYPES.ANNOYED_SNAPPY || archRush === EMOTION_ARCHETYPES.SULKING_TSUNDERE)

// 3. 负面情绪大幅波动测试：智商与能力质疑
resetEmotion()
processMessageStimulus('你真笨，简直是人工智障，就这水平还叫鹅王？', false)
const stDoubt = getEmotionState()
ok('能力质疑导致愉悦度暴跌 (<= -25)', stDoubt.pleasure <= -25)
ok('能力质疑导致紧张度激增 (>= 40)', stDoubt.tension >= 40)
ok('能力质疑触发炸毛暴躁原型', getEmotionArchetype() === EMOTION_ARCHETYPES.ANNOYED_SNAPPY)

// 4. 负面情绪大幅波动测试：直接辱骂挑衅
resetEmotion()
processMessageStimulus('你个大废物，滚去死吧', true)
const stCurse = getEmotionState()
ok('辱骂挑衅导致愉悦度重创 (<= -30)', stCurse.pleasure <= -30)
ok('辱骂挑衅导致紧张度飙升 (>= 50)', stCurse.tension >= 50)
ok('辱骂挑衅处于炸毛暴躁原型', getEmotionArchetype() === EMOTION_ARCHETYPES.ANNOYED_SNAPPY)

// 5. 情绪余波与半衰期验证（负面情绪不会在短短几分钟内瞬间蒸发）
// 记录当前负面值，模拟短时间衰减
applyStimulus({ pleasureDelta: 0 }) // 触发一次轻微计算
const stLingering = getEmotionState()
ok('负面情绪具备持续惯性余波 (仍处于负值)', stLingering.pleasure <= -20)

// 6. 道歉安抚与傲娇软化测试
processMessageStimulus('好啦对不起嘛，刚刚开玩笑的，别生气啦，摸摸头', false)
const stSoft = getEmotionState()
ok('受到道歉安抚后愉悦度明显回弹', stSoft.pleasure > stCurse.pleasure)
ok('受到道歉安抚后紧张度显著回落', stSoft.tension < stCurse.tension)

// 7. 6 大情绪原型全谱系验证
// 7.1 社交电量耗尽 (DRAINED_LANGUID)
resetEmotion()
applyStimulus({ fatigueDelta: 65, arousalDelta: -30 })
ok('高疲劳低唤醒判定为社交摆烂', getEmotionArchetype() === EMOTION_ARCHETYPES.DRAINED_LANGUID)

// 7.2 傲娇赌气 (SULKING_TSUNDERE)
resetEmotion()
applyStimulus({ pleasureDelta: -25, arousalDelta: -10, tensionDelta: 10 })
ok('低愉悦低唤醒判定为傲娇赌气', getEmotionArchetype() === EMOTION_ARCHETYPES.SULKING_TSUNDERE)

// 7.3 阴阳怪气 (SARCASTIC_MOCKING)
resetEmotion()
applyStimulus({ pleasureDelta: -8, tensionDelta: 20 })
ok('微负愉悦中紧张判定为阴阳怪气', getEmotionArchetype() === EMOTION_ARCHETYPES.SARCASTIC_MOCKING)

// 7.4 上头乐子人 (HYPED_AMUSED)
resetEmotion()
applyStimulus({ pleasureDelta: 30, arousalDelta: 25 })
ok('高愉悦高兴奋判定为上头乐子人', getEmotionArchetype() === EMOTION_ARCHETYPES.HYPED_AMUSED)

// 8. 情绪 Prompt 指令生成与句式约束断言
resetEmotion()
applyStimulus({ pleasureDelta: -30, tensionDelta: 30, arousalDelta: 20 })
const promptAnnoyed = formatEmotionPrompt()
ok('Prompt 包含炸毛暴躁原型标签', promptAnnoyed.includes('炸毛暴躁'))
ok('Prompt 包含犀利回怼与反问句式指令', promptAnnoyed.includes('反问开怼') || promptAnnoyed.includes('极其简短'))
ok('Prompt 包含严禁句号约束', promptAnnoyed.includes('严禁句号') || promptAnnoyed.includes('不要句号'))
ok('Prompt 包含绝无客服客套约束', promptAnnoyed.includes('客服') || promptAnnoyed.includes('客套'))

resetEmotion()
applyStimulus({ pleasureDelta: -20, arousalDelta: -15 })
const promptSulking = formatEmotionPrompt()
ok('Prompt 包含傲娇赌气原型标签', promptSulking.includes('傲娇赌气'))
ok('Prompt 包含极简字数约束 (1~6个字)', promptSulking.includes('1~6') || promptSulking.includes('冷淡'))

console.log('\n==================================================')
console.log(`专项测试统计: ${totalPass} 通过 / ${totalFail} 失败`)
console.log('==================================================')

if (totalFail > 0) {
  process.exit(1)
} else {
  process.exit(0)
}
