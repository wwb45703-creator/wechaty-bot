import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WechatyBuilder } from 'wechaty'
import config from './config-loader.js'
import { initAi } from './ai.js'
import { setMemoryEnabled } from './memory.js'
import { logger } from './logger.js'
import { onMessage } from './handlers/on-message.js'
import { handleRoomJoin } from './handlers/room.js'
import { initScheduler } from './scheduler.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const puppet = process.env.WECHATY_PUPPET || 'wechaty-puppet-xp'

initAi(config)
setMemoryEnabled(config.memory?.enabled !== false)

// 每小时自检：清理 puppet-xp 的消息缓存（它无限增长，官方标了 FIXME）+ 记录内存占用
setInterval(() => {
  try {
    const store = bot.puppet?.messageStore
    if (store && Object.keys(store).length > 0) {
      const size = Object.keys(store).length
      for (const k of Object.keys(store)) delete store[k]
      logger.info(`定时清理：消息缓存 ${size} 条已释放`)
    }
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024)
    logger.info(`自检：node 内存 ${rss}MB`)
    if (rss > 800) logger.warn(`node 内存超过 800MB，建议重启机器人`)
  } catch (e) {
    logger.warn(`自检失败: ${e.message}`)
  }
}, 60 * 60 * 1000).unref()

const bot = WechatyBuilder.build({
  name: path.join(__dirname, '..', 'wechaty-bot.memory'),
  puppet,
})

bot
  .on('scan', (qrcode, status) => {
    // puppet-xp 的登录发生在微信客户端内，此事件一般不会触发；
    // 其他 puppet 场景下可把该链接生成二维码扫码登录
    const url = `https://wechaty.js.org/qrcode/?q=${encodeURIComponent(qrcode)}`
    logger.info(`扫码登录（status ${status}）: ${url}`)
  })
  .on('login', async (user) => {
    logger.info(`用户已登录: ${user.name()}`)
    try {
      const rooms = await bot.Room.findAll()
      logger.info(`当前共加入 ${rooms.length} 个群`)
      const topics = await Promise.all(rooms.map((r) => r.topic().catch(() => '')))
      for (const rc of config.rooms || []) {
        if (!topics.includes(rc.topic)) {
          logger.warn(`config 中登记的群"${rc.topic}"尚未加入，机器人被拉入该群后自动生效`)
        }
      }
    } catch (e) {
      logger.warn(`群列表读取失败: ${e.message}`)
    }
    initScheduler(bot)
  })
  .on('logout', (user) => logger.warn(`用户已登出: ${user.name()}`))
  .on('error', (err) => {
    // puppet-xp 回放历史消息时的已知噪音，不属于故障
    if (String(err?.message || '').includes('message not found for id')) return
    logger.error(`bot error: ${err?.message || err}`)
  })
  .on('room-join', handleRoomJoin)
  .on('message', onMessage)

async function main() {
  logger.info(`启动 Wechaty 机器人，puppet=${puppet}，AI 模型=${config.ai.model}（${config.ai.baseUrl}）`)
  await bot.start()
  logger.info('机器人已启动。请确保微信 3.9.10.27 客户端已在本机登录。')
}

process.on('SIGINT', async () => {
  logger.info('收到退出信号，正在停止...')
  try {
    await bot.stop()
  } catch {}
  process.exit(0)
})

main().catch((err) => {
  logger.error(`启动失败: ${err?.stack || err}`)
  process.exit(1)
})
