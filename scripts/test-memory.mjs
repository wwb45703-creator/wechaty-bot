/**
 * 长期记忆端到端测试（不依赖微信）：
 *   node scripts/test-memory.mjs            用当前配置模型测试
 *   node scripts/test-memory.mjs cross      先 qwen3 测读写，再切 llama3.1:8B 验证跨模型读取
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initAi, chat, extractFacts, resetConversation } from '../src/ai.js'
import { appendFacts, formatForPrompt, getMemory, clearMemory } from '../src/memory.js'
import config from '../src/config-loader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
initAi(config)

const REF = { scope: 'private', userId: 'test_user_mem', displayName: '测试用户' }
const KEY = 'private:test_user_mem'

async function runRound(tag) {
  console.log(`\n===== ${tag}（模型: ${config.ai.model}）=====`)
  resetConversation(KEY)

  // 1. 告知信息 → AI 回复 → 提取 → 落盘
  const r1 = await chat({ key: KEY, userText: '我叫小王，今年17岁，在读高中，我养了一只叫煤球的黑猫，周末都在打原神。', memoryText: '' })
  console.log('回复1:', (r1 || '(失败)').slice(0, 80))
  const facts = await extractFacts({ userText: '我叫小王，今年17岁，在读高中，我养了一只叫煤球的黑猫，周末都在打原神。', assistantReply: r1 || '' })
  const added = appendFacts(REF, facts || [], '测试用户')
  console.log(`提取要点 ${facts?.length ?? 0} 条，落盘 ${added} 条`)
  if (!added) {
    console.log('❌ 没有提取到记忆，测试失败')
    return false
  }

  // 2. 新会话 + 注入记忆 → 验证能答出记忆内容
  resetConversation(KEY)
  const memText = formatForPrompt(REF, 15)
  const r2 = await chat({ key: KEY, userText: '我养的宠物叫什么名字？什么颜色？', memoryText: memText })
  console.log('回复2:', (r2 || '(失败)').slice(0, 80))
  const ok = r2 && r2.includes('煤球')
  console.log(ok ? '✅ 记忆注入生效（答出"煤球"）' : '❌ 记忆未生效')
  return ok
}

// 落盘文件检查
function dumpFile() {
  const file = path.join(__dirname, '..', 'memories', 'private', 'test_user_mem.json')
  console.log('\n--- 记忆文件内容 ---')
  console.log(fs.readFileSync(file, 'utf8'))
}

clearMemory(REF)
const ok1 = await runRound('第一遍：当前模型')
dumpFile()

if (process.argv[2] === 'cross') {
  // 跨模型：改 config 的 model 字段后重跑读取部分
  const configPath = path.join(__dirname, '..', 'config.json')
  const backup = fs.readFileSync(configPath, 'utf8')
  try {
    const patched = backup.replace('"model": "[^"]*"', '"model": "llama3.1:8B"')
    fs.writeFileSync(configPath, patched, 'utf8')
    // 重新加载 config + 重新初始化 AI
    delete globalThis.__configCache
    const cfg2 = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    initAi(cfg2)
    resetConversation(KEY)
    const memText = formatForPrompt(REF, 15)
    const r = await chat({ key: KEY, userText: '我养的宠物叫什么名字？什么颜色？', memoryText: memText })
    console.log(`\n===== 跨模型读取（llama3.1:8B）=====`)
    console.log('回复:', (r || '(失败)').slice(0, 80))
    console.log(r && r.includes('煤球') ? '✅ 换模型后记忆仍可读取' : '❌ 跨模型读取失败')
  } finally {
    fs.writeFileSync(configPath, backup, 'utf8') // 恢复原模型
  }
}

console.log('\n清理测试记忆...')
clearMemory(REF)
console.log(ok1 ? '\n测试通过 ✅' : '\n测试失败 ❌')
process.exit(ok1 ? 0 : 1)
