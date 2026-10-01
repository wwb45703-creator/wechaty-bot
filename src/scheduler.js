import cron from 'node-cron'
import config, { findRoomConfig } from './config-loader.js'
import { logger } from './logger.js'
import { generateOnce } from './ai.js'

/**
 * 定时主动任务：按 config.proactive 里的 cron 表达式，
 * 向指定群发送 AI 生成的话题（或固定问候语）。
 * node-cron 默认使用本机时区。
 */
let schedulerReady = false

export function initScheduler(bot) {
  if (schedulerReady) return // 幂等：微信重登录不重复注册 cron（否则主动话题翻倍发送）
  schedulerReady = true
  const jobs = config.proactive || []
  if (jobs.length === 0) {
    logger.info('未配置任何主动话题任务（config.proactive 为空）')
    return
  }

  for (const job of jobs) {
    if (!cron.validate(job.cron)) {
      logger.error(`主动任务 cron 表达式不合法，已跳过: ${job.cron}（群：${job.roomTopic}）`)
      continue
    }
    cron.schedule(job.cron, async () => {
      try {
        const room = await bot.Room.find({ topic: job.roomTopic }).catch(() => null)
        if (!room) {
          logger.warn(`定时任务找不到群"${job.roomTopic}"，请确认群名与 config.rooms 一致`)
          return
        }
        let content
        if (job.type === 'greeting') {
          content = job.prompt
        } else {
          content = await generateOnce(job.prompt)
        }
        if (content) {
          await room.say(content)
          logger.info(`已向群"${job.roomTopic}"发送主动${job.type === 'greeting' ? '问候' : '话题'}: ${content.slice(0, 50)}`)
        } else {
          logger.warn(`群"${job.roomTopic}"话题生成失败（Ollama 无响应），本次跳过`)
        }
      } catch (err) {
        logger.error(`定时任务执行失败: ${err?.stack || err}`)
      }
    })
    logger.info(`主动任务已注册: 群"${job.roomTopic}" cron=${job.cron} type=${job.type}`)
  }
}

/** 手动触发一次主动话题（测试用）：node src/scheduler.js --run 0 */
export async function runProactiveOnce(bot, index) {
  const job = (config.proactive || [])[index]
  if (!job) throw new Error(`config.proactive[${index}] 不存在`)
  const room = await bot.Room.find({ topic: job.roomTopic })
  if (!room) throw new Error(`找不到群"${job.roomTopic}"`)
  const content = job.type === 'greeting' ? job.prompt : await generateOnce(job.prompt)
  if (!content) throw new Error('Ollama 生成失败')
  await room.say(content)
  logger.info(`手动触发成功，已发送到群"${job.roomTopic}"`)
}
