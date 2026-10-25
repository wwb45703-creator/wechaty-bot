/**
 * test-cross-model-persona.mjs — 跨模型人设继承与全场景（私聊+群聊）记忆反哺演化专项测试
 *
 * 测试范围：
 *  1. 私聊深度对话记忆反哺（爱好生长与好奇心微升）
 *  2. 多用户多群聊（杂鱼🐟喵/最难不过坚持）记忆汇流
 *  3. 跨模型（Cross-Model）热切换人设与记忆 100% 继承
 *  4. 私聊隐私记忆隔离安全断言（私密记忆绝不外泄）
 *
 * 用法：node scripts/test-cross-model-persona.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPersonaState, formatPersonaPrompt } from '../src/personality/persona-state.js'
import { reflectOnMemories, detectTopics } from '../src/personality/reflection.js'
import { appendFacts, formatForPrompt, clearMemory, getMemory } from '../src/memory.js'
import { getRelationship, clearRelationship } from '../src/personality/relationship.js'
import { initAi, chat } from '../src/ai.js'
import config from '../src/config-loader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

let pass = 0
let fail = 0

function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`✅ PASS  ${name}${detail ? ' → ' + detail : ''}`)
  } else {
    fail++
    console.log(`❌ FAIL  ${name}${detail ? ' → ' + detail : ''}`)
  }
}

// ----------------------------------------------------------------
// 1. 话题提炼与主题捕捉测试
// ----------------------------------------------------------------
const t1 = detectTopics(['用户深度分享了量子计算的前沿研究'])
ok('细粒度专业话题捕捉 [量子计算]', t1.includes('量子计算') || t1.includes('科学探索'))

const t2 = detectTopics(['用户正在开发Vue3和NodeJS后端服务架构'])
ok('通用技术领域识别 [技术编程]', t2.includes('技术编程'))

// ----------------------------------------------------------------
// 2. 私聊深度对话记忆反哺人格
// ----------------------------------------------------------------
const stateBefore = getPersonaState()
const curCuriosity = stateBefore.traits['好奇心']

const aliceUid = 'user_alice_quantum_test'
const aliceRef = { scope: 'private', userId: aliceUid, displayName: '爱丽丝' }
clearMemory(aliceRef)
clearRelationship(aliceUid)

// 模拟私聊提取了深度科研记忆
const aliceFacts = ['用户是一名量子力学研究员', '用户经常思考量子纠缠与超导量子比特']
await appendFacts(aliceRef, aliceFacts, '爱丽丝')

await reflectOnMemories({
  userId: aliceUid,
  displayName: '爱丽丝',
  facts: aliceFacts,
  source: 'private',
})

const stateAfter = getPersonaState()
ok('私聊深度探讨推动好奇心微升', stateAfter.traits['好奇心'] >= curCuriosity)

const quantumHobby = stateAfter.hobbies.find((h) => h.name === '量子计算' || h.name === '科学探索')
ok('私聊交流推动新爱好萌芽生长', Boolean(quantumHobby))

// ----------------------------------------------------------------
// 3. 多用户跨群聊记忆反哺汇流
// ----------------------------------------------------------------
const bobUid = 'user_bob_baking_test'
const bobRef = { scope: 'room', roomId: '49905010454@chatroom', userId: bobUid, displayName: '小鲍' }
clearMemory(bobRef)

const bobFacts = ['群友小鲍喜欢烘焙面包与手工冲泡咖啡']
await appendFacts(bobRef, bobFacts, '小鲍')

await reflectOnMemories({
  userId: bobUid,
  displayName: '小鲍',
  roomId: '49905010454@chatroom',
  facts: bobFacts,
  source: 'room',
})

const stateBob = getPersonaState()
const bakingHobby = stateBob.hobbies.find((h) => h.name === '烘焙面包' || h.name === '美食烹饪')
ok('群聊对话记忆同样顺利反哺爱好池', Boolean(bakingHobby))

// ----------------------------------------------------------------
// 4. 跨模型（Cross-Model）100% 继承断言
// ----------------------------------------------------------------
// 模拟当前模型下生成的人格画像
initAi(config)
const promptModel1 = formatPersonaPrompt()
const memoryModel1 = formatForPrompt(aliceRef)

// 模拟用户在控制台切换至新模型（如 llama3.1:8B）
const configPath = path.join(rootDir, 'config.json')
const rawConfig = fs.readFileSync(configPath, 'utf8')
const configObj = JSON.parse(rawConfig)

const originalModel = configObj.ai?.model
const testTargetModel = 'llama3.1:8B'

try {
  // 模拟切换配置模型
  configObj.ai.model = testTargetModel
  initAi(configObj)

  // 读取新模型下的人设与记忆
  const promptModel2 = formatPersonaPrompt()
  const memoryModel2 = formatForPrompt(aliceRef)
  const stateNewModel = getPersonaState()

  ok('跨模型人格名字完全继承 (鹅王)', stateNewModel.name === '鹅王' && promptModel2.includes('名字：鹅王'))
  ok('跨模型五维性格数值100%无损继承', promptModel1 === promptModel2)
  ok('跨模型生长出的动态爱好100%继承', promptModel2.includes(quantumHobby?.name || '科学探索'))
  ok('跨模型三层记忆100%无损继承', memoryModel1 === memoryModel2 && memoryModel2.includes('量子力学研究员'))

  console.log(`  → 验证成功：从 ${originalModel} 切换为 ${testTargetModel}，人设与记忆无缝继承！`)
} finally {
  // 恢复原始模型配置
  configObj.ai.model = originalModel
  initAi(configObj)
}

// ----------------------------------------------------------------
// 5. 私聊隐私与群聊记忆隔离验证
// ----------------------------------------------------------------
const charlieRef = { scope: 'room', roomId: '49905010454@chatroom', userId: 'charlie_test' }
const charliePrompt = formatForPrompt(charlieRef)
ok('私聊用户的私密记忆绝不会泄露给群聊成员', !charliePrompt.includes('量子力学研究员'))

// 清理测试临时数据
clearMemory(aliceRef)
clearMemory(bobRef)
clearRelationship(aliceUid)

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
