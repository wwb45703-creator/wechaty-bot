import cron from 'node-cron'
import config from './config-loader.js'
import { logger } from './logger.js'
import { chat } from './ai.js'
import { generateMorningBrief } from './reach/morning-brief.js'
import { processMessage, admitMessage } from './messaging.js'

let schedulerReady = false
async function findTarget(bot, job) {
  if (job.roomId) return bot.Room.find({ id: job.roomId }).catch(() => null)
  if (!job.roomTopic) return null
  // Refuse ambiguous names rather than silently delivering to the first room.
  const matches = await bot.Room.findAll({ topic: job.roomTopic }).catch(() => [])
  return matches.length === 1 ? matches[0] : null
}
export async function runProactiveOnce(bot, index, occurrence = `manual:${Date.now()}`) {
  const job = config.proactive?.[index]
  if (!job || job.enabled === false || config.scheduler?.enabled === false) return { status: 'disabled' }
  const room = await findTarget(bot, job)
  if (!room) return { status: 'missing-or-ambiguous-room' }
  const talker = { id: 'scheduler', name: () => '定时任务', self: () => false }
  const msg = { id: `cron:${index}:${occurrence}`, wechaty: bot, talker: () => talker, self: () => false, text: () => job.prompt || '' }
  const a = await admitMessage(msg, room)
  if (!a) return { status: 'denied' }
  return processMessage({ msg, room, admission: a, kind: 'cron', producer: async (ctx) => {
    let text
    if (job.type === 'greeting') text = job.prompt
    else if (job.type === 'brief') text = await generateMorningBrief(job.prompt || '早上好', { signal: ctx.signal, scope: ctx.scope, epoch: ctx.epoch })
    else text = await chat({ key: `cron-once:${ctx.messageId}`, userText: job.prompt || '发起一个简短话题',
      scope: ctx.scope, epoch: ctx.epoch, signal: ctx.signal, personaName: ctx.scope.personaId })
    return { text, learn: false }
  } })
}
export function initScheduler(bot) {
  if (schedulerReady) return
  schedulerReady = true
  if (config.scheduler?.enabled === false) return
  for (const [index, job] of (config.proactive || []).entries()) {
    if (job.enabled === false || !cron.validate(job.cron)) continue
    cron.schedule(job.cron, () => {
      const occurrence = new Date().toISOString().slice(0, 16)
      runProactiveOnce(bot, index, occurrence).catch((error) => logger.error(`定时任务失败: ${error?.code || error?.name}`))
    }, { timezone: config.scheduler?.timezone || 'Asia/Shanghai' })
  }
}
