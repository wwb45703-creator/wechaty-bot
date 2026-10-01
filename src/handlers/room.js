import config, { findRoomConfig } from '../config-loader.js'
import { logger } from '../logger.js'
import { chat, extractFacts, resetConversation } from '../ai.js'
import { checkRate, recordReply } from '../rate-limit.js'
import { splitBubbles, sendBubbles, stripAtMentions } from '../utils.js'
import { isMemoryEnabled, formatForPrompt, appendFacts, clearMemory, getMemory } from '../memory.js'
import { handlePersonaCommand, getActivePersonaName } from '../persona-commands.js'

/**
 * 群聊自动回复：
 * - mode = "mention"：被 @ 或消息含唤醒词时回复（默认）
 * - mode = "all"：群内每条消息都回复（慎用，容易刷屏）
 */

/** 去掉 @xxx 等提及噪音，留下干净的问题文本 */
function cleanMention(text, botName) {
  let t = text
  for (const n of new Set([botName, ...Object.values(config.defaultWakeWords || [])])) {
    if (n) t = t.split(`@${n}`).join('')
  }
  return t.replace(/@\S+\s?/g, '').trim() || text.trim()
}

export async function handleRoomMessage(msg, room) {
  const text = msg.text().trim()
  if (!text) return

  const topic = await room.topic().catch(() => '(未知群名)')
  const rc = findRoomConfig(topic)
  if (rc && rc.enabled === false) return

  const talker = msg.talker()
  const name = talker.name()

  // 冒烟测试 / 菜单：群里直接可用，不限模式
  if (config.dingDong && text.toLowerCase() === 'ding') {
    await room.say(`@${name} dong`, talker)
    return
  }
  if (config.menu.enabled && text === config.menu.keyword) {
    await room.say(`@${name}\n${config.menu.content}`, talker)
    return
  }

  const mode = rc?.mode ?? config.defaultRoomMode ?? 'mention'
  const wakeWords = rc?.wakeWords ?? config.defaultWakeWords ?? []

  let selfName = '' // 机器人昵称（函数级：@ 剥离和触发判定共用）
  let triggered = false
  if (mode === 'all') {
    triggered = true
  } else {
    // puppet-xp 不回传 mention 列表，这里用"文本包含 @机器人昵称"做主判定
    const w = msg.wechaty
    selfName = w?.currentUser?.name?.() || w?.userSelf?.()?.name?.() || ''
    const atMe = selfName && text.includes(`@${selfName}`)
    const mentioned = atMe || (await msg.mentionSelf().catch(() => false))
    const wake = wakeWords.some((w) => w && text.includes(w))
    triggered = Boolean(mentioned) || wake
  }
  if (!triggered) return

  const key = `room:${topic}`
  const cooldown = rc?.cooldownSeconds ?? 10
  const limit = checkRate(key, cooldown, config.roomDailyLimit ?? 500)
  if (!limit.allowed) {
    logger.info(`群[${topic}]冷却中（剩余 ${limit.remainingSeconds ?? '?'}s）`)
    return
  }

  const question = cleanMention(text, config.defaultWakeWords?.[0] || '')
  logger.info(`群[${topic}] ${name} -> ${question.slice(0, 50)}`)

  // 长期记忆：每群每人一份档案（room.id 稳定，不随群改名变化）
  const memRef = { scope: 'room', roomId: room.id, userId: talker.id, displayName: name, roomTopic: topic }
  if (isMemoryEnabled()) {
    if (question === '忘记我') {
      clearMemory(memRef)
      await room.say(`@${name} 好，你在这个群里的记忆我删掉了。`, talker)
      recordReply(key, 0)
      return
    }
    if (question === '我的记忆') {
      const mem = getMemory(memRef)
      if (!mem.facts.length) {
        await room.say(`@${name} 我还没记住关于你的什么～`, talker)
      } else {
        const lines = mem.facts.slice(-10).map((f) => `- ${f.text}（${f.date}）`)
        await room.say(`@${name} 我记着的关于你的事：\n${lines.join('\n')}\n（说"忘记我"可清除）`, talker)
      }
      recordReply(key, 0)
      return
    }
  }

  // 拍一拍：@机器人 说"拍我"（拍一拍仅群聊有；只能拍指令发送者本人）
  // ⚠️ 实验特性：agent 的拍一拍回声消息会导致微信崩溃（BLOCKED），默认关闭
  if (config.pat?.enabled === true && /^(拍我|拍拍我|拍一下我|拍一拍)$/.test(question)) {
    try {
      const sidecar = msg.wechaty?.puppet?.sidecar
      if (!sidecar?.patMsg) {
        await room.say(`@${name} 我还不会拍人……`, talker)
      } else {
        await sidecar.patMsg(room.id, talker.id)
        logger.info(`已拍一拍（群[${topic}] ${name}）`)
      }
    } catch (e) {
      logger.error(`拍一拍失败: ${e.message}`)
      await room.say(`@${name} 拍不动，出了点小问题`, talker).catch(() => {})
    }
    recordReply(key, 0)
    return
  }

  // 人设切换命令（人人可切，本群独立生效）
  const personaRef = { scope: 'room', roomId: room.id, userId: talker.id }
  const personaHandled = handlePersonaCommand({
    text: question,
    ref: personaRef,
    chatKey: key,
    reply: (t) => room.say(`@${name} ${t}`, talker).catch(() => {}),
  })
  if (personaHandled) {
    recordReply(key, 0)
    return
  }

  const memoryText = isMemoryEnabled() ? formatForPrompt(memRef, config.memory?.maxFacts ?? 15) : ''
  const reply = await chat({
    key,
    userText: `${name} 说：${question}`,
    systemExtra: `当前是微信群"${topic}"的群聊，多个成员一起聊天，你回复时会自动@说话的人。请针对 ${name} 的问题自然地接话。`,
    memoryText,
    personaName: getActivePersonaName(personaRef),
  })
  if (reply) {
    const bubbles = splitBubbles(reply)
    // @ 提醒只由代码在首条添加；AI 内容里的 @xx 全部剥离（防 "@额 @额" 叠加）
    await sendBubbles(async (t, i) => {
      const clean = stripAtMentions(t, [name, selfName].filter(Boolean))
      if (i === 0) await room.say(`@${name} ${clean}`, talker)
      else await room.say(clean)
    }, bubbles, config.ai.replyDelaySeconds)
    recordReply(key, config.roomDailyLimit ?? 500)
    if (isMemoryEnabled()) {
      setImmediate(() => {
        extractFacts({ userText: `${name} 说：${question}`, assistantReply: reply }).then((facts) => {
          if (facts && facts.length) {
            const added = appendFacts(memRef, facts, name)
            if (added) logger.info(`长期记忆 +${added}（群[${topic}] ${name}）`)
          }
        })
      })
    }
  } else {
    await room.say(`@${name} ${config.ai.fallbackReply}`, talker).catch(() => {})
  }
}

/** 新成员进群欢迎（room-join 事件） */
export async function handleRoomJoin(room, invitees) {
  if (!config.welcome?.enabled) return
  const topic = await room.topic().catch(() => null)
  const rc = topic ? findRoomConfig(topic) : undefined
  if (!rc) return // 只在 config.rooms 里登记过的群欢迎
  const names = invitees.map((c) => c.name()).join('、')
  const line = (config.welcome.template || '欢迎 {新人} 加入！').replace('{新人}', names)
  await room.say(line).catch((e) => logger.error(`欢迎语发送失败: ${e.message}`))
  logger.info(`群[${topic}] 新成员 ${names} 进群，已发送欢迎语`)
}
