import config from '../config-loader.js'
import { logger } from '../logger.js'
import { chat, extractFacts } from '../ai.js'
import { checkRate, recordReply } from '../rate-limit.js'
import { splitBubbles, sendBubbles } from '../utils.js'
import { isMemoryEnabled, formatForPrompt, appendFacts, clearMemory, getMemory } from '../memory.js'
import { resetConversation } from '../ai.js'
import { handlePersonaCommand, getActivePersonaName } from '../persona-commands.js'

/**
 * 私聊自动回复
 */
export async function handlePrivateMessage(msg) {
  const talker = msg.talker()
  const text = msg.text().trim()
  if (!text) return

  const name = talker.name()
  const alias = (await talker.alias().catch(() => null)) || ''

  // 白名单为空 = 对所有人生效
  const whitelist = config.private.whitelist || []
  if (whitelist.length > 0) {
    const hit = whitelist.some((w) => w === name || w === alias)
    if (!hit) {
      logger.info(`私聊跳过（不在白名单）: ${alias || name}`)
      return
    }
  }

  const key = `private:${talker.id}`
  const limit = checkRate(key, config.private.cooldownSeconds ?? 30, config.private.dailyLimit ?? 200)
  if (!limit.allowed) {
    if (limit.reason === 'cooldown') {
      logger.info(`私聊冷却中（剩余 ${limit.remainingSeconds}s）: ${name}`)
    } else {
      logger.info(`私聊达到每日上限: ${name}`)
    }
    return
  }

  // 冒烟测试快捷指令
  if (config.dingDong && text.toLowerCase() === 'ding') {
    await msg.say('dong')
    recordReply(key, 0)
    return
  }

  if (config.menu.enabled && text === config.menu.keyword) {
    await msg.say(config.menu.content)
    recordReply(key, 0)
    return
  }

  // 长期记忆管理命令（本人操作本人档案）
  const memRef = { scope: 'private', userId: talker.id, displayName: alias || name }
  if (isMemoryEnabled()) {
    if (text === '我的记忆') {
      const mem = getMemory(memRef)
      if (!mem.facts.length) {
        await msg.say('我还没记住关于你的什么，多聊聊就有了～')
      } else {
        const lines = mem.facts.slice(-15).map((f) => `- ${f.text}（${f.date}）`)
        await msg.say(`我记着的关于你的事：\n${lines.join('\n')}\n（说"忘记我"可全部清除）`)
      }
      recordReply(key, 0)
      return
    }
    if (text === '忘记我') {
      clearMemory(memRef)
      resetConversation(key)
      await msg.say('好，关于你的记忆我都删掉了，我们从新认识吧。')
      recordReply(key, 0)
      return
    }
  }

  // 人设切换命令（私聊好友独立生效）
  const personaRef = { scope: 'private', userId: talker.id }
  const personaHandled = handlePersonaCommand({
    text,
    ref: personaRef,
    reply: (t) => msg.say(t).catch(() => {}),
  })
  if (personaHandled) {
    recordReply(key, 0)
    return
  }

  logger.info(`私聊回复 -> ${alias || name}: ${text.slice(0, 50)}`)
  const memoryText = isMemoryEnabled() ? formatForPrompt(memRef, config.memory?.maxFacts ?? 15) : ''
  const reply = await chat({
    key,
    userText: text,
    systemExtra: '当前是微信私聊，对方直接和你一对一说话。',
    memoryText,
    personaName: getActivePersonaName(personaRef),
  })
  if (reply) {
    const bubbles = splitBubbles(reply)
    await sendBubbles((t) => msg.say(t), bubbles, config.ai.replyDelaySeconds)
    recordReply(key, config.private.dailyLimit ?? 200)
    // 回复完成后，后台提取长期记忆（不阻塞回复）
    if (isMemoryEnabled()) {
      setImmediate(() => {
        extractFacts({ userText: text, assistantReply: reply }).then((facts) => {
          if (facts && facts.length) {
            const added = appendFacts(memRef, facts, alias || name)
            if (added) logger.info(`长期记忆 +${added}（私聊 ${alias || name}）`)
          }
        })
      })
    }
  } else {
    await msg.say(config.ai.fallbackReply).catch(() => {})
  }
}
