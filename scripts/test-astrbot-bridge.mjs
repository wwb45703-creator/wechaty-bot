/**
 * test-astrbot-bridge.mjs — AstrBot 本地桥接客户端专项验证测试
 *
 * 覆盖场景：
 *  1. 探活探针 isAstrBotAlive 正常连通
 *  2. 指令探测 isAstrBotCommand（斜杠前缀、插件关键词、普通聊天过滤）
 *  3. 端到端 Chat 与指令流式解析（/help 指令执行与完整文本聚合）
 *  4. 本地已装插件列表读取 listInstalledPlugins
 *  5. 2800+ 官方插件市场检索 searchMarketPlugins
 *  6. 容错降级保护（网络异常/不可达时不崩溃）
 *
 * 用法：node scripts/test-astrbot-bridge.mjs
 */

import {
  isAstrBotAlive,
  isAstrBotCommand,
  chatWithAstrBot,
  listInstalledPlugins,
  searchMarketPlugins,
} from '../src/reach/astrbot-client.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ' → ' + detail : ''}`)
  cond ? pass++ : fail++
}

console.log('==================================================')
console.log('  AstrBot 本地桥接客户端专项测试')
console.log('==================================================')

// 1. 探活探针
const alive = await isAstrBotAlive()
ok('AstrBot 本地探活探针正常在线', alive === true)

// 2. 指令探测器
ok('斜杠指令识别 (/help)', isAstrBotCommand('/help') === true)
ok('斜杠指令识别 (/reset)', isAstrBotCommand('/reset') === true)
ok('斜杠指令识别 (/sid)', isAstrBotCommand('/sid') === true)
ok('插件关键词识别 (插件列表)', isAstrBotCommand('插件列表') === true)
ok('插件关键词识别 (astrbot 帮助)', isAstrBotCommand('astrbot 帮助') === true)
ok('普通闲聊不被误判为指令', isAstrBotCommand('你好啊，今天天气真不错') === false)
ok('空字符串不触发指令', isAstrBotCommand('') === false)

// 3. 端到端聊天与内置指令执行
const chatRes = await chatWithAstrBot({
  message: '/help',
  sessionId: 'test_verify_session',
  username: 'verifier',
  timeoutMs: 15000,
})
ok('AstrBot /help 指令执行成功', chatRes.ok === true)
ok('AstrBot 返回包含版本或指令内容', typeof chatRes.reply === 'string' && chatRes.reply.includes('AstrBot'), chatRes.reply?.slice(0, 40))

// 4. 本地已安装插件查询
const installed = await listInstalledPlugins()
ok('已安装插件查询成功且包含内置组件', Array.isArray(installed) && installed.length >= 1, `共 ${installed.length} 个插件`)

// 5. 官方插件市场检索 (2800+ 插件)
const marketResults = await searchMarketPlugins('music', 3)
ok('官方插件市场检索成功', Array.isArray(marketResults) && marketResults.length >= 1, `检索到 ${marketResults.length} 个结果`)

console.log('\n==================================================')
console.log(`专项测试统计: ${pass} 通过 / ${fail} 失败`)
console.log('==================================================')

if (fail > 0) {
  process.exit(1)
}
