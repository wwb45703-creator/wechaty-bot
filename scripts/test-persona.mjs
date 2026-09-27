/**
 * 人设切换端到端测试（不依赖微信）：
 *   node scripts/test-persona.mjs
 * 验证：默认角色 → 切喵酱（口吻变化）→ 持久化 → 恢复默认。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { initAi, chat, resetConversation } from '../src/ai.js'
import { handlePersonaCommand, getActivePersonaName } from '../src/persona-commands.js'
import config from '../src/config-loader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
initAi(config)

const REF = { scope: 'private', userId: 'test_user_persona' }
const KEY = 'private:test_user_persona'
const stateFile = path.join(__dirname, '..', 'state', 'personas.json')

function replyTexts(t) { return t }
async function ask(text, personaName) {
  resetConversation(KEY)
  const reply = await chat({
    key: KEY,
    userText: text,
    systemExtra: '当前是微信私聊。',
    personaName,
  })
  return (reply || '(失败)').slice(0, 90)
}

let ok = true

// 1. 默认角色（鹅王）
const def = getActivePersonaName(REF)
const r1 = await ask('用一句话介绍你自己', def)
console.log(`[${def}] ${r1}`)
if (def !== '鹅王') { console.log('❌ 默认角色不是鹅王'); ok = false }

// 2. 命令：变成喵酱
let handled = handlePersonaCommand({ text: '变成喵酱', ref: REF, reply: (t) => console.log('[命令回复]', t) })
if (!handled) { console.log('❌ 变成喵酱 命令未被识别'); ok = false }
const after = getActivePersonaName(REF)
console.log('切换后激活角色:', after)

// 3. 持久化验证
const stateOnDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
if (stateOnDisk.private?.test_user_persona !== '喵酱') { console.log('❌ 持久化失败'); ok = false }
else console.log('✅ 状态已持久化到 state/personas.json')

// 4. 喵酱口吻
const r2 = await ask('用一句话介绍你自己', getActivePersonaName(REF))
console.log(`[喵酱] ${r2}`)
if (!/喵/.test(r2)) { console.log('❌ 喵酱口吻未生效'); ok = false }

// 5. 未知角色
handled = handlePersonaCommand({ text: '变成奥特曼', ref: REF, reply: (t) => console.log('[命令回复]', t) })
if (!handled) { console.log('❌ 未知角色命令未处理'); ok = false }

// 6. 恢复默认
handled = handlePersonaCommand({ text: '恢复默认', ref: REF, reply: (t) => console.log('[命令回复]', t) })
const r3 = await ask('用一句话介绍你自己', getActivePersonaName(REF))
console.log(`[恢复后] ${r3}`)
if (!/鹅王/.test(r3) && !/原神/.test(r3)) { console.log('❌ 恢复默认失败'); ok = false }

// 清理测试状态
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
delete st.private.test_user_persona
fs.writeFileSync(stateFile, JSON.stringify(st, null, 2), 'utf8')

console.log(ok ? '\n测试通过 ✅' : '\n测试失败 ❌')
process.exit(ok ? 0 : 1)
