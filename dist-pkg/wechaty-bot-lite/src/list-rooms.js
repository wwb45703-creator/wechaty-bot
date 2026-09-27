// 诊断：直接查看 puppet 内部 roomStore 的群资料
import { WechatyBuilder } from 'wechaty'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const bot = WechatyBuilder.build({
  name: path.join(__dirname, '..', 'wechaty-bot.memory'),
  puppet: 'wechaty-puppet-xp',
})

bot.on('login', async () => {
  await new Promise((r) => setTimeout(r, 12000))
  const puppet = bot.puppet
  const store = puppet.roomStore || {}
  const keys = Object.keys(store)
  console.log(`roomStore 条目数: ${keys.length}`)
  let named = 0
  for (const k of keys) {
    const t = store[k]?.topic || ''
    if (t) {
      named++
      console.log(JSON.stringify({ id: k, topic: t, memberCount: (store[k]?.memberIdList || []).length }))
    }
  }
  console.log(`有名字的群: ${named}/${keys.length}`)
  if (keys.length > 0) {
    console.log('样例 payload:', JSON.stringify(store[keys[0]]).slice(0, 300))
  }
  const rooms = await bot.Room.findAll()
  console.log(`Room.findAll: ${rooms.length} 个`)
  if (rooms[0]) {
    await rooms[0].ready().catch((e) => console.log('ready fail:', e.message))
    console.log('第一个 room payload:', JSON.stringify(rooms[0].payload).slice(0, 300))
  }
  await bot.stop()
  process.exit(0)
})

bot.on('error', () => {})

await bot.start()
setTimeout(() => { console.error('超时未登录'); process.exit(1) }, 90000)
