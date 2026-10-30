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
import { migrateLegacy } from './social/index.js'
import { dataPath } from './runtime-paths.js'
import { getMessagingRuntime } from './messaging.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const puppet = process.env.WECHATY_PUPPET || 'wechaty-puppet-xp'
let socialReady = false

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
  name: dataPath('wechaty-bot.memory'),
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
      const migration = await migrateLegacy({ accountId: user.id,
        defaultPersona: config.defaultPersona || 'default', personas: config.personas || {} })
      if (migration.accountId !== user.id) logger.info('历史迁移已绑定原账号；当前账号使用独立社交状态')
      await getMessagingRuntime().ready()
      socialReady = true
      logger.info(`社交存储就绪，迁移状态=${migration.status}，待核查项=${migration.warnings?.length || 0}`)
    } catch (error) {
      socialReady = false
      logger.error(`社交存储未就绪，暂停消息处理：${error.message}`)
      return
    }
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
  .on('logout', (user) => { socialReady = false; logger.warn(`用户已登出: ${user.name()}`) })
  .on('error', (err) => {
    // puppet-xp 回放历史消息时的已知噪音，不属于故障
    if (String(err?.message || '').includes('message not found for id')) return
    logger.error(`bot error: ${err?.message || err}`)
  })
  .on('room-join', handleRoomJoin)
  .on('message', (message) => socialReady ? onMessage(message) : undefined)

async function main() {
  logger.info(`启动 Wechaty 机器人，puppet=${puppet}，AI 模型=${config.ai?.model || '未设置'}`)
  // 写 PID 文件：UI/看门狗零开销检测机器人进程（避免每几秒跑一次 PowerShell 查询）
  try {
    fs.mkdirSync(dataPath('state'), { recursive: true })
    fs.writeFileSync(dataPath('state', 'bot.pid'), String(process.pid))
  } catch {}
  await bot.start()
  logger.info('机器人已启动。请确保微信 3.9.10.27 客户端已在本机登录。')
}

async function shutdown(signal) {
  logger.info(`收到 ${signal} 信号，正在停止...`)
  try { await bot.stop() } catch {}
  try { fs.unlinkSync(dataPath('state', 'bot.pid')) } catch {}
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// 兜底：未捕获异常只记日志，不让进程意外崩溃（Frida/Wechaty 偶发异步抛错）
process.on('unhandledRejection', (reason) => {
  logger.error(`未处理的 Promise 拒绝: ${reason?.stack || reason}`)
})
process.on('uncaughtException', (err) => {
  logger.error(`未捕获的同步异常: ${err?.stack || err}`)
  // 严重错误仍需退出，但先写日志确保记录
  if (err?.code === 'ERR_IPC_DISCONNECTED' || err?.code === 'ECONNRESET') return
  process.exit(1)
})

main().catch((err) => {
  logger.error(`启动失败: ${err?.stack || err}`)
  process.exit(1)
})
