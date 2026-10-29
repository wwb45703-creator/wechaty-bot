/**
 * test-ui-astrbot-ipc.mjs — AstrBot 控制台 IPC 桥接接口专项验证测试
 *
 * 用法：node scripts/test-ui-astrbot-ipc.mjs
 */

import {
  isAstrBotAlive,
  getAstrBotStatus,
  listInstalledPlugins,
  searchMarketPlugins,
  listKnowledgeBases,
  togglePlugin,
  chatWithAstrBot,
} from '../src/reach/astrbot-client.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ' → ' + detail : ''}`)
  cond ? pass++ : fail++
}

console.log('==================================================')
console.log('  AstrBot 控制台 IPC 桥接层专项验收测试')
console.log('==================================================')

// 1. 服务在线探针
const alive = await isAstrBotAlive(2000)

if (alive) {
  ok('AstrBot 服务在线探活探针 (isAstrBotAlive)', alive === true)

  // 2. 控制台状态聚合 (astrbot:status)
  const status = await getAstrBotStatus()
  ok('控制台状态聚合读取成功 (getAstrBotStatus)', status.alive === true && status.version === '4.29.3')
  ok('插件数量与知识库数量字段规范', typeof status.pluginCount === 'number' && typeof status.kbCount === 'number', `插件: ${status.pluginCount}, 知识库: ${status.kbCount}`)

  // 3. 已安装插件列表 (astrbot:plugins:list)
  const installed = await listInstalledPlugins()
  ok('已安装插件列表获取成功', Array.isArray(installed) && installed.length >= 1)
  const hasBuiltin = installed.some((p) => p.name === 'builtin_commands' || p.name === 'astrbot')
  ok('已装插件包含核心内置包', hasBuiltin)

  // 4. 社区插件市场检索 (astrbot:plugins:market)
  const market = await searchMarketPlugins('weather', 5)
  ok('2800+ 社区插件市场在线检索成功', Array.isArray(market))

  // 5. 插件状态切换 (astrbot:plugins:toggle)
  const toggle = await togglePlugin({ name: 'builtin_commands', enabled: true })
  ok('插件启用/禁用状态切换接口 (togglePlugin)', toggle.ok === true)

  // 6. 知识库列表 (astrbot:kb:list)
  const kb = await listKnowledgeBases()
  ok('知识库列表接口健全性 (listKnowledgeBases)', kb.ok === true && Array.isArray(kb.data))

  // 7. 指令与插件对话链路 (chatWithAstrBot)
  const chat = await chatWithAstrBot({
    message: '/help',
    sessionId: 'test_ipc_session',
    username: 'ipc_tester',
    timeoutMs: 15000,
  })
  ok('指令与插件端到端调用成功', chat.ok === true && typeof chat.reply === 'string')
} else {
  console.log('ℹ️ AstrBot 服务当前未运行，验证 IPC 控制台离线容错能力...')
  ok('AstrBot 服务离线探针准确报告 (alive === false)', alive === false)

  const status = await getAstrBotStatus()
  ok('控制台状态聚合安全降级', status.alive === false && status.pluginCount === 0)
  ok('插件数量与知识库数量字段规范', typeof status.pluginCount === 'number' && typeof status.kbCount === 'number', `插件: ${status.pluginCount}, 知识库: ${status.kbCount}`)

  const installed = await listInstalledPlugins()
  ok('离线时已安装插件返回空列表', Array.isArray(installed) && installed.length === 0)

  const toggle = await togglePlugin({ name: 'builtin_commands', enabled: true })
  ok('离线时插件开关操作安全容错', toggle.ok === false)

  const kb = await listKnowledgeBases()
  ok('离线时知识库列表安全降级', kb.ok === false)

  const chat = await chatWithAstrBot({
    message: '/help',
    sessionId: 'test_ipc_session',
    username: 'ipc_tester',
    timeoutMs: 500,
  })
  ok('离线时指令与插件对话安全返回降级对象', chat.ok === false)
}

console.log('\n==================================================')
console.log(`IPC 专项测试统计: ${pass} 通过 / ${fail} 失败`)
console.log('==================================================')

if (fail > 0) {
  process.exit(1)
}
