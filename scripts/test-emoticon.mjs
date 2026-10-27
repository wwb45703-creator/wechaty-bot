/**
 * test-emoticon.mjs — 微信表情包 (type=5) 互动与冷却专项测试
 *
 * 用法：node scripts/test-emoticon.mjs
 */

import { isEmoticonEnabled, handleEmoticonMessage } from '../src/handlers/on-emoticon.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ' → ' + detail : ''}`)
  cond ? pass++ : fail++
}

console.log('==================================================')
console.log('  微信表情包互动专项测试')
console.log('==================================================')

// 1. 基础开关
ok('表情包互动功能默认开启', isEmoticonEnabled() === true)

// 2. 模拟消息交互
let sentPrivate = null
const mockPrivateMsg = {
  text: () => '<msg><emoji md5="test123456" /></msg>',
  talker: () => ({
    id: 'test_talker_emoticon_1',
    name: () => '测试表情发送者',
  }),
  say: async (text) => {
    sentPrivate = text
    return true
  },
}

await handleEmoticonMessage(mockPrivateMsg, null)
ok('私聊表情包成功触发回应', Boolean(sentPrivate), sentPrivate)

// 3. 冷却机制测试（10s 内重复发表情包应被限流，不再产生新发送）
sentPrivate = null
await handleEmoticonMessage(mockPrivateMsg, null)
ok('表情包冷却保护生效（连续发送被限流）', sentPrivate === null)

// 4. 群聊表情包交互
let sentRoom = null
const mockRoomMsg = {
  text: () => '<msg><emoji md5="testroom123" /></msg>',
  talker: () => ({
    id: 'test_talker_emoticon_room',
    name: () => '群友小王',
  }),
}
const mockRoom = {
  id: 'test_chatroom_1',
  topic: async () => '最难不过坚持',
  say: async (text) => {
    sentRoom = text
    return true
  },
}

await handleEmoticonMessage(mockRoomMsg, mockRoom)
ok('群聊表情包成功触发回应并包含@', Boolean(sentRoom) && sentRoom.includes('@群友小王'), sentRoom)

console.log('\n==================================================')
console.log(`专项测试统计: ${pass} 通过 / ${fail} 失败`)
console.log('==================================================')

if (fail > 0) {
  process.exit(1)
}
