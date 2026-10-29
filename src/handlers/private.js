import config from '../config-loader.js'
import { logger } from '../logger.js'
import { chat, extractFacts, resetConversation, isAiDisabled } from '../ai.js'
import { checkRate, recordReply } from '../rate-limit.js'
import { splitBubbles, sendBubbles, cleanBubbleText } from '../utils.js'
import { isMemoryEnabled, formatForPrompt, appendFacts, clearMemory, getMemory } from '../memory.js'
import { handlePersonaCommand, getActivePersonaName } from '../persona-commands.js'
import { clearRelationship } from '../personality/relationship.js'
import { reflectOnMemories } from '../personality/reflection.js'
import { isAstrBotCommand, chatWithAstrBot, isAstrBotAlive, listInstalledPlugins } from '../reach/astrbot-client.js'

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
  const whitelist = config.private?.whitelist || []
  if (whitelist.length > 0) {
    const hit = whitelist.some((w) => w === name || w === alias)
    if (!hit) {
      logger.info(`私聊跳过（不在白名单）: ${alias || name}`)
      return
    }
  }

  const key = `private:${talker.id}`
  const limit = checkRate(key, config.private?.cooldownSeconds ?? 30, config.private?.dailyLimit ?? 200)
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

  if (config.menu?.enabled && text === config.menu?.keyword) {
    await msg.say(config.menu?.content)
    recordReply(key, 0)
    return
  }

  // 长期记忆管理命令（本人操作本人档案）
  const memRef = { scope: 'private', userId: talker.id, displayName: alias || name }
  if (isMemoryEnabled()) {
    if (text === '我的记忆') {
      const mem = getMemory(memRef)
      const hasFacts = mem.facts && mem.facts.length > 0
      const hasEpisodes = mem.episodes && mem.episodes.length > 0
      if (!hasFacts && !hasEpisodes) {
        await msg.say('我还没记住关于你的什么，多聊聊就有了～')
      } else {
        const parts = []
        if (hasFacts) {
          const lines = mem.facts.slice(-15).map((f) => `- ${f.text}（${f.date}）`)
          parts.push(`【事实与偏好】\n${lines.join('\n')}`)
        }
        if (hasEpisodes) {
          const epLines = mem.episodes.slice(-5).map((e) => `- ${e.description}（${e.date}）`)
          parts.push(`【重要共同经历】\n${epLines.join('\n')}`)
        }
        await msg.say(`我记着的关于你的事：\n${parts.join('\n\n')}\n（说"忘记我"可全部清除）`)
      }
      recordReply(key, 0)
      return
    }
    if (text === '忘记我') {
      clearMemory(memRef)
      clearRelationship(talker.id)
      resetConversation(key)
      await msg.say('好，关于你的记忆与互动记录我都删掉了，我们从新认识吧。')
      recordReply(key, 0)
      return
    }
  }

  // 人设切换命令（私聊好友独立生效）
  const personaRef = { scope: 'private', userId: talker.id }
  const personaHandled = handlePersonaCommand({
    text,
    ref: personaRef,
    chatKey: key,
    reply: (t) => msg.say(t).catch(() => {}),
  })
  if (personaHandled) {
    recordReply(key, 0)
    return
  }

  // AstrBot 插件与技能指令转发
  if (isAstrBotCommand(text)) {
    const alive = await isAstrBotAlive()
    if (alive) {
      if (/^(astrbot|插件)\s*(列表|list)$/i.test(text)) {
        const plugins = await listInstalledPlugins()
        const pluginList = plugins.map((p) => `• ${p.display_name || p.name} (v${p.version}): ${p.desc || '无描述'}`).join('\n')
        await msg.say(`🧩 【AstrBot 已启用插件 (${plugins.length}个)】\n${pluginList || '暂无已启用插件'}`)
        recordReply(key, 0)
        return
      }
      logger.info(`[AstrBot] 转发私聊指令 -> ${alias || name}: ${text}`)
      const astrRes = await chatWithAstrBot({
        message: text,
        sessionId: `private:${talker.id}`,
        username: alias || name,
      })
      if (astrRes.ok && astrRes.reply) {
        const bubbles = splitBubbles(astrRes.reply)
        await sendBubbles((t) => {
          logger.info(`[AstrBot回复私聊] ${alias || name} -> ${t.slice(0, 60)}`)
          return msg.say(t)
        }, bubbles, config.ai?.replyDelaySeconds)
        recordReply(key, 0)
        return
      }
    }
  }

  logger.info(`私聊回复 -> ${alias || name}: ${text.slice(0, 50)}`)
  const memoryText = isMemoryEnabled() ? formatForPrompt(memRef, config.memory?.maxFacts ?? 15) : ''
  const reply = await chat({
    key,
    userText: text,
    systemExtra: '当前是微信私聊，对方直接和你一对一说话。',
    memoryText,
    personaName: getActivePersonaName(personaRef),
    talkerId: talker.id,
    talkerName: alias || name,
  })
  if (reply) {
    const bubbles = splitBubbles(reply)
    await sendBubbles((t) => {
      logger.info(`[回复私聊] ${alias || name} -> ${t.slice(0, 60)}`)
      return msg.say(t)
    }, bubbles, config.ai?.replyDelaySeconds)
    recordReply(key, config.private?.dailyLimit ?? 200)
    // 回复完成后，后台提取长期记忆（不阻塞回复）
    if (isMemoryEnabled()) {
      const requestedAt = Date.now()
      setImmediate(() => {
        extractFacts({ userText: text, assistantReply: reply }).then(async (facts) => {
          if (facts && facts.length) {
            const added = await appendFacts(memRef, facts, alias || name, requestedAt)
            if (added) logger.info(`长期记忆 +${added}（私聊 ${alias || name}）`)
            // 记忆反哺人格演化（全场景多用户汇流）
            reflectOnMemories({
              userId: talker.id,
              displayName: alias || name,
              facts,
              source: 'private',
            }).catch(() => {})
          }
        }).catch((e) => logger.warn(`记忆提取/写盘失败（私聊）: ${e?.message || e}`))
      })
    }
  } else {
    const rawFallback = isAiDisabled() ? 'AI 对话服务暂时未开启' : (config.ai?.fallbackReply || '网卡了，稍等再发一遍？')
    const fallbackText = cleanBubbleText(rawFallback)
    await msg.say(fallbackText).catch(() => {})
  }
}
