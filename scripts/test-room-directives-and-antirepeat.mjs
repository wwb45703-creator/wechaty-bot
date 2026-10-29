/**
 * test-room-directives-and-antirepeat.mjs
 *
 * 专项测试套件：
 * 1. 群聊用户指令/说话约定识别与捕获 (captureDirectiveFromText)
 * 2. 群指令持久化、同人更新、异人追加、FIFO 上限与 Prompt 注入 (room-directives)
 * 3. 文本 2-gram Jaccard 相似度算法准确率 (textSimilarity)
 * 4. 单条回复内部近义气泡去重 (splitBubbles)
 * 5. 消息 ID 级去重防护与并发穿透拦截 (isDuplicateMessage)
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import {
  captureDirectiveFromText,
  recordRoomDirective,
  getRoomDirectives,
  formatRoomDirectivesPrompt,
  clearRoomDirectives,
} from '../src/personality/room-directives.js'
import { textSimilarity, splitBubbles } from '../src/utils.js'
import { isDuplicateMessage } from '../src/handlers/on-message.js'

let totalTests = 0
let passedTests = 0

function runTest(name, fn) {
  totalTests++
  try {
    fn()
    passedTests++
    console.log(`  ✅ [PASS] ${name}`)
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`)
    throw err
  }
}

console.log('==================================================')
console.log('  群指令记忆与防重复发言专项验收测试')
console.log('==================================================')

// ----------------------------------------------------
// 1. 群友指令捕获与识别测试
// ----------------------------------------------------
console.log('\n--- 1. 群友说话约定与口吻指令捕获 (captureDirectiveFromText) ---')

runTest('成功捕获“加喵字”口头禅约定', () => {
  const t = '请你把之后说的每句话后面都加个喵字'
  const captured = captureDirectiveFromText(t)
  assert.ok(captured, '应当成功捕获指令')
  assert.strictEqual(captured, t)
})

runTest('成功捕获“叫我主人”称谓约定', () => {
  const t = '以后叫我主人，听清楚了没有'
  const captured = captureDirectiveFromText(t)
  assert.ok(captured, '应当成功捕获称谓约定')
})

runTest('成功捕获“记住不要聊某话题”约定', () => {
  const t = '给我记住，不要在群里聊政治话题'
  const captured = captureDirectiveFromText(t)
  assert.ok(captured, '应当成功捕获禁令约定')
})

runTest('成功捕获人设与身份变更约定', () => {
  const t = '从现在开始你是个高冷死傲娇'
  const captured = captureDirectiveFromText(t)
  assert.ok(captured, '应当成功捕获人设约定')
})

runTest('成功捕获口尾/词首口头禅约定', () => {
  const t = '每句话后面都要带个emoji表情'
  const captured = captureDirectiveFromText(t)
  assert.ok(captured, '应当成功捕获带emoji约定')
})

runTest('正常聊天疑问句不误判为指令', () => {
  const t1 = '今天晚上吃什么好呢？'
  const t2 = '群里有人在打瓦吗？'
  const t3 = '为什么这个代码报错了？'
  assert.strictEqual(captureDirectiveFromText(t1), null, '常规问题不应误判')
  assert.strictEqual(captureDirectiveFromText(t2), null, '常规聊天不应误判')
  assert.strictEqual(captureDirectiveFromText(t3), null, '常规问询不应误判')
})

// ----------------------------------------------------
// 2. 群指令持久化、同人更新与 Prompt 注入测试
// ----------------------------------------------------
console.log('\n--- 2. 群指令持久化与 Prompt 格式化 (room-directives) ---')

const TEST_ROOM_ID = 'test_room_antirepeat_12345'

// 先清空测试遗留
clearRoomDirectives(TEST_ROOM_ID)

runTest('初始状态群指令为空', () => {
  const list = getRoomDirectives(TEST_ROOM_ID)
  assert.deepStrictEqual(list, [])
  assert.strictEqual(formatRoomDirectivesPrompt(TEST_ROOM_ID), '')
})

runTest('用户“睿”提出指令并记录成功', () => {
  recordRoomDirective(TEST_ROOM_ID, '睿', '请你把每句话后面都加个喵字')
  const list = getRoomDirectives(TEST_ROOM_ID)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].userName, '睿')
  assert.strictEqual(list[0].text, '请你把每句话后面都加个喵字')
})

runTest('同用户“睿”更新指令则覆盖，不重复堆叠', () => {
  recordRoomDirective(TEST_ROOM_ID, '睿', '以后跟我说话每句末尾必须带喵，且态度要恭敬')
  const list = getRoomDirectives(TEST_ROOM_ID)
  assert.strictEqual(list.length, 1, '同人应覆盖更新，列表长度应保持 1')
  assert.strictEqual(list[0].text, '以后跟我说话每句末尾必须带喵，且态度要恭敬')
})

runTest('异用户“小明”提出新约定则追加', () => {
  recordRoomDirective(TEST_ROOM_ID, '小明', '叫我明哥，不要叫我群友')
  const list = getRoomDirectives(TEST_ROOM_ID)
  assert.strictEqual(list.length, 2, '异人应追加，列表长度应为 2')
  assert.strictEqual(list[1].userName, '小明')
})

runTest('Prompt 格式化正确并包含群友约定标记', () => {
  const prompt = formatRoomDirectivesPrompt(TEST_ROOM_ID)
  assert.ok(prompt.includes('本群专属群友指令与约定'), '应包含标题标记')
  assert.ok(prompt.includes('群友 睿 约定'), '应包含群友睿约定')
  assert.ok(prompt.includes('群友 小明 约定'), '应包含群友小明约定')
})

runTest('FIFO 上限保护，超过 6 条时淘汰最老指令', () => {
  for (let i = 1; i <= 8; i++) {
    recordRoomDirective(TEST_ROOM_ID, `测试成员${i}`, `这是测试指令${i}`)
  }
  const list = getRoomDirectives(TEST_ROOM_ID)
  assert.strictEqual(list.length, 6, '最大限制应为 6 条')
  assert.strictEqual(list[list.length - 1].userName, '测试成员8')
})

runTest('clearRoomDirectives 彻底清空并持久化清理', () => {
  clearRoomDirectives(TEST_ROOM_ID)
  assert.deepStrictEqual(getRoomDirectives(TEST_ROOM_ID), [])
  assert.strictEqual(formatRoomDirectivesPrompt(TEST_ROOM_ID), '')
})

// ----------------------------------------------------
// 3. 文本 2-gram Jaccard 相似度算法准确率测试
// ----------------------------------------------------
console.log('\n--- 3. 文本相似度计算算法 (textSimilarity) ---')

runTest('完全一致文本相似度为 1.0', () => {
  const s = textSimilarity('你这不就是电子榨菜嘛！', '你这不就是电子榨菜嘛！')
  assert.strictEqual(s, 1)
})

runTest('真实复现案例：一字之差的车轱辘话复读相似度 >= 0.80', () => {
  const s1 = '你这不就是电子榨菜嘛！666'
  const s2 = '我这不就是电子榨菜嘛！666'
  const sim = textSimilarity(s1, s2)
  console.log(`    (真实复现相似度: ${(sim * 100).toFixed(1)}%)`)
  assert.ok(sim >= 0.80, '高雷同车轱辘话相似度应当 >= 0.80')
})

runTest('完全不同文本相似度极低 (< 0.25)', () => {
  const s1 = '今天下大雨路上堵车一个小时'
  const s2 = '明天晚上大家一起去吃海鲜自助餐'
  const sim = textSimilarity(s1, s2)
  assert.ok(sim < 0.25, `无关文本相似度应低，实际: ${sim}`)
})

// ----------------------------------------------------
// 4. 单条回复内部近义气泡去重测试 (splitBubbles)
// ----------------------------------------------------
console.log('\n--- 4. 气泡拆分与消息内去重 (splitBubbles) ---')

runTest('过滤单次回复内的多气泡自言自语复读', () => {
  const raw = '你这不就是电子榨菜嘛！666 ||| 我这不就是电子榨菜嘛！666'
  const bubbles = splitBubbles(raw, 3)
  assert.strictEqual(bubbles.length, 1, '重复气泡必须被去重过滤为 1 条')
  assert.strictEqual(bubbles[0], '你这不就是电子榨菜嘛！666')
})

runTest('正常不同内容的多气泡连发不被误杀', () => {
  const raw = '行啊没问题，今天下午搞定 ||| 等下把代码推给你，记得拉取'
  const bubbles = splitBubbles(raw, 3)
  assert.strictEqual(bubbles.length, 2, '正常非重复多气泡应全部保留')
  assert.strictEqual(bubbles[0], '行啊没问题，今天下午搞定')
  assert.strictEqual(bubbles[1], '等下把代码推给你，记得拉取')
})

// ----------------------------------------------------
// 5. 消息 ID 级去重防护测试 (isDuplicateMessage)
// ----------------------------------------------------
console.log('\n--- 5. 消息事件去重防御 (isDuplicateMessage) ---')

runTest('同一消息 ID 60 秒内第二次进入判定为重复', () => {
  const testId = `msg_test_${Date.now()}`
  assert.strictEqual(isDuplicateMessage(testId), false, '初次接收应放行')
  assert.strictEqual(isDuplicateMessage(testId), true, '同一ID重复推送应立即拦截')
})

runTest('不同消息 ID 互不干扰正常放行', () => {
  const id1 = `msg_test_a_${Date.now()}`
  const id2 = `msg_test_b_${Date.now()}`
  assert.strictEqual(isDuplicateMessage(id1), false)
  assert.strictEqual(isDuplicateMessage(id2), false)
})

console.log('\n==================================================')
console.log(`🎉 专项测试全部通过！通过数: ${passedTests}/${totalTests}`)
console.log('==================================================\n')
