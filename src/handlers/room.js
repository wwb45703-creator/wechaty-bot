import config, { findRoomConfig } from '../config-loader.js'
import { logger } from '../logger.js'
import { chat, extractFacts, resetConversation, isAiDisabled } from '../ai.js'
import { checkRate, recordReply } from '../rate-limit.js'
import { splitBubbles, sendBubbles, stripAtMentions } from '../utils.js'
import { isMemoryEnabled, formatForPrompt, appendFacts, clearMemory, getMemory } from '../memory.js'
import { handlePersonaCommand, getActivePersonaName } from '../persona-commands.js'
import { reflectOnMemories } from '../personality/reflection.js'
import { recordGroupMessage } from '../personality/linguistic-mirror.js'
import { detectImplicitSearchIntent } from './search.js'
import { webSearch } from '../reach/search.js'
import { isAstrBotCommand, chatWithAstrBot, isAstrBotAlive, listInstalledPlugins } from '../reach/astrbot-client.js'

/**
 * 群聊自动回复：
 * - mode = "mention"：被 @ 或消息含唤醒词时回复（默认）
 * - mode = "all"：群内每条消息都回复（慎用，容易刷屏）
 */

/** 去掉 @xxx 等提及噪音、唤醒词及指令前缀，留下干净的问题文本 */
export function cleanMention(text, botName, rc = {}) {
  let t = text
  const wakeWords = rc?.wakeWords ?? config.defaultWakeWords ?? []
  const prefixes = rc?.prefixes ?? []

  // 1. 去除 @ 自身及默认唤醒词
  for (const n of new Set([botName, ...wakeWords, ...Object.values(config.defaultWakeWords || [])])) {
    if (n) t = t.split(`@${n}`).join('')
  }
  t = t.replace(/@\S+\s?/g, '').trim()

  // 2. 去除前缀唤醒符号（如 "？天气如何" -> "天气如何"）
  for (const p of prefixes) {
    if (p && t.startsWith(p)) {
      t = t.slice(p.length).trim()
      break
    }
  }

  // 3. 如果是以唤醒词开头的，去除句首唤醒词（如 "小助手 推荐电影" -> "推荐电影"）
  for (const w of wakeWords) {
    if (w && t.startsWith(w)) {
      t = t.slice(w.length).trim()
      break
    }
  }

  return t || text.trim()
}

/** 智能疑问句与求助意图探测（字数 >= 5 且符合问句特征） */
export function isQuestionIntent(text) {
  const t = String(text || '').trim()
  if (t.length < 5) return false

  // 问号结尾
  if (/[?？]$/.test(t)) return true

  // 典型疑问词与求助短语
  const questionPatterns = [
    /^(请问|有人知道|求助|谁知道|想问下|问一下|弱弱问)/,
    /(怎么(样|办|弄|做|走|买|查|用)|为什么|为啥|如何|哪(里|个|家|儿)|谁有|多少钱)/,
    /(是(不是|吗|否)|对(不对|吗)|行(不行|吗)|好(不好|吗)|可以(吗|不)|能(不能|吗))([?？\s]|$)/,
    /(有没有|能不能|可不可|会不会)/,
  ]

  return questionPatterns.some((pattern) => pattern.test(t))
}

/**
 * 群消息触发判定（供文本回复与搜索分支共用）：
 *  1. 机器人自己发言绝对不触发（杜绝死循环）
 *  2. mode === 'all'：全量免 @ 畅聊模式恒触发
 *  3. mention 模式：被 @机器人昵称 / mentionSelf 判定
 *  4. 唤醒词模式：文本包含 rc.wakeWords 或 config.defaultWakeWords
 *  5. 符号前缀模式：文本以 rc.prefixes 开头（如 "?", "？", "/", "bot"）
 *  6. 疑问意图模式：rc.smartQuestion === true 且包含疑问词/问号且字数达标
 *  7. 概率插话模式：设置了 rc.randomRate（0.0 ~ 1.0）且随机命中
 * 返回 { triggered, selfName, triggerReason }
 */
export async function checkRoomTrigger(msg, text, rc = {}) {
  const w = msg.wechaty
  const selfName = w?.currentUser?.name?.() || w?.userSelf?.()?.name?.() || ''

  // 铁律：机器人自身发言绝不自触发
  const talker = msg.talker()
  if (talker?.self?.() || (selfName && talker?.name?.() === selfName)) {
    return { triggered: false, selfName }
  }

  const mode = rc?.mode ?? config.defaultRoomMode ?? 'mention'

  // 1. 全量畅聊模式
  if (mode === 'all') {
    return { triggered: true, selfName, triggerReason: 'mode:all' }
  }

  // 2. 被 @ 触发
  const atMe = selfName && text.includes(`@${selfName}`)
  const mentioned = atMe || (await msg.mentionSelf().catch(() => false))
  if (mentioned) {
    return { triggered: true, selfName, triggerReason: 'mention' }
  }

  // 3. 唤醒词触发
  const wakeWords = rc?.wakeWords ?? config.defaultWakeWords ?? []
  const hitWake = wakeWords.find((x) => x && text.includes(x))
  if (hitWake) {
    return { triggered: true, selfName, triggerReason: `wake:${hitWake}` }
  }

  // 4. 符号前缀触发（如 "?天气", "！帮助"）
  const prefixes = rc?.prefixes ?? []
  const hitPrefix = prefixes.find((p) => p && text.startsWith(p))
  if (hitPrefix) {
    return { triggered: true, selfName, triggerReason: `prefix:${hitPrefix}` }
  }

  // 5. 智能疑问句意图触发 (smartQuestion)
  if (rc?.smartQuestion) {
    if (isQuestionIntent(text)) {
      return { triggered: true, selfName, triggerReason: 'smartQuestion' }
    }
  }

  // 6. 气氛担当/概率插话模式 (randomRate)
  if (typeof rc?.randomRate === 'number' && rc.randomRate > 0) {
    if (Math.random() < rc.randomRate) {
      return { triggered: true, selfName, triggerReason: 'randomRate' }
    }
  }

  return { triggered: false, selfName }
}

export async function handleRoomMessage(msg, room) {
  const text = msg.text().trim()
  if (!text) return

  // 记录本群真实发言，推进群聊语言镜像自适应（吸收本群高频口头禅）
  recordGroupMessage(room.id, text)

  const topic = await room.topic().catch(() => '(未知群名)')
  const rc = findRoomConfig(topic, room.id)
  if (rc && rc.enabled === false) return

  const talker = msg.talker()
  const name = talker.name()

  // 冒烟测试 / 菜单：群里直接可用，不限模式
  if (config.dingDong && text.toLowerCase() === 'ding') {
    await room.say(`@${name} dong`, talker)
    return
  }
  if (config.menu?.enabled && text === config.menu?.keyword) {
    await room.say(`@${name}\n${config.menu?.content}`, talker)
    return
  }

  const { triggered, selfName, triggerReason } = await checkRoomTrigger(msg, text, rc)
  if (!triggered) return

  const key = `room:${topic}`
  const cooldown = rc?.cooldownSeconds ?? 10
  const limit = checkRate(key, cooldown, config.roomDailyLimit ?? 500)
  if (!limit.allowed) {
    logger.info(`群[${topic}]冷却中（剩余 ${limit.remainingSeconds ?? '?'}s）`)
    return
  }

  const question = cleanMention(text, selfName, rc)
  logger.info(`群[${topic}] ${name} -> ${question.slice(0, 50)}`)

  const shouldAt = rc?.atSender === false ? false : (rc?.atSender === true || triggerReason === 'mention')

  // 查群 ID 指令：无论群名如何变化，方便直接获取永久恒定的 roomId
  if (['查群ID', '群ID', '查群', '群信息'].includes(question)) {
    const members = await room.memberAll().catch(() => [])
    const info = `📋 【当前群信息】\n群名：${topic}\n群ID：${room.id}\n成员数：${members.length || '未知'}\n\n💡 提示：在 config.json 的 rooms 中配置 "id": "${room.id}"，群改名后机器人依然能准确认出该群！`
    await room.say(`@${name}\n${info}`, talker).catch(() => {})
    recordReply(key, 0)
    return
  }

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

  // AstrBot 插件与技能指令转发
  if (isAstrBotCommand(question)) {
    const alive = await isAstrBotAlive()
    if (alive) {
      if (/^(astrbot|插件)\s*(列表|list)$/i.test(question)) {
        const plugins = await listInstalledPlugins()
        const pluginList = plugins.map((p) => `• ${p.display_name || p.name} (v${p.version}): ${p.desc || '无描述'}`).join('\n')
        await room.say(`@${name}\n🧩 【AstrBot 已启用插件 (${plugins.length}个)】\n${pluginList || '暂无已启用插件'}`, talker).catch(() => {})
        recordReply(key, 0)
        return
      }
      logger.info(`[AstrBot] 转发群[${topic}]指令: ${question}`)
      const astrRes = await chatWithAstrBot({
        message: question,
        sessionId: room.id,
        username: name,
      })
      if (astrRes.ok && astrRes.reply) {
        const bubbles = splitBubbles(astrRes.reply)
        await sendBubbles((t) => {
          const body = stripAtMentions(t)
          const textToSend = shouldAt ? `@${name} ${body}` : body
          return room.say(textToSend, talker)
        }, bubbles, config.ai?.replyDelaySeconds)
        recordReply(key, 0)
        return
      }
    }
  }

  let systemExtra = shouldAt
    ? `当前是微信群"${topic}"的群聊，多个成员一起聊天，你回复时会自动@说话的人。请针对 ${name} 的问题自然地接话。`
    : `当前是微信群"${topic}"的群聊，你作为一个群成员像真实网友打字一样自然参与群聊交流，不要机械地@对方，直接像普通群友一样自然地接话。`

  // 类 Grok 隐式时效性搜索意图检测与自动事实注入（免唤醒词）
  const implicitQuery = detectImplicitSearchIntent(question)
  if (implicitQuery) {
    try {
      const searchRes = await webSearch(implicitQuery, { numResults: 3, timeoutMs: 8000 })
      if (searchRes && Array.isArray(searchRes.results) && searchRes.results.length > 0) {
        const facts = searchRes.results.slice(0, 3).map((r, i) => `${i + 1}. ${r.title}: ${r.snippet || ''}`).join('\n')
        systemExtra += `\n\n【后台实时联网检索到的最新资讯（类Grok自动吃瓜事实）】\n${facts}\n请以“鹅王”的松弛吃瓜网友口吻回复，自然融入上述最新事实进行调侃吐槽，严禁机械报菜名。`
        logger.info(`[隐式搜索] 命中时效性意图 [${implicitQuery}]，已自动注入 ${searchRes.results.length} 条实时事实`)
      }
    } catch (e) {
      logger.warn(`[隐式搜索] 自动检索异常: ${e.message}`)
    }
  }

  const memoryText = isMemoryEnabled() ? formatForPrompt(memRef, config.memory?.maxFacts ?? 15) : ''
  const reply = await chat({
    key,
    userText: `${name} 说：${question}`,
    systemExtra,
    memoryText,
    personaName: getActivePersonaName(personaRef),
    talkerId: talker.id,
    talkerName: name,
    roomId: room.id,
  })
  if (reply) {
    const bubbles = splitBubbles(reply)
    // @ 提醒只在需要时首条添加；AI 内容里的 @xx 全部剥离（防 "@额 @额" 叠加）
    await sendBubbles(async (t, i) => {
      const clean = stripAtMentions(t, [name, selfName].filter(Boolean))
      if (!clean) return
      logger.info(`[回复群] 群[${topic}] -> ${clean.slice(0, 60)}`)
      if (i === 0 && shouldAt) await room.say(`@${name} ${clean}`, talker)
      else await room.say(clean)
    }, bubbles, config.ai?.replyDelaySeconds)
    recordReply(key, config.roomDailyLimit ?? 500)
    if (isMemoryEnabled()) {
      const requestedAt = Date.now()
      setImmediate(() => {
        extractFacts({ userText: `${name} 说：${question}`, assistantReply: reply }).then(async (facts) => {
          if (facts && facts.length) {
            const added = await appendFacts(memRef, facts, name, requestedAt)
            if (added) logger.info(`长期记忆 +${added}（群[${topic}] ${name}）`)
            // 记忆反哺人格演化（全场景多用户汇流）
            reflectOnMemories({
              userId: talker.id,
              displayName: name,
              roomId: room.id,
              facts,
              source: 'room',
            }).catch(() => {})
          }
        }).catch((e) => logger.warn(`记忆提取/写盘失败（群[${topic}]）: ${e?.message || e}`))
      })
    }
  } else {
    const fallbackText = isAiDisabled() ? '（AI 对话服务暂时未开启）' : config.ai?.fallbackReply
    await room.say(`@${name} ${fallbackText}`, talker).catch(() => {})
  }
}

/** 新成员进群欢迎（room-join 事件） */
export async function handleRoomJoin(room, invitees) {
  if (!config.welcome?.enabled) return
  const topic = await room.topic().catch(() => null)
  const rc = topic ? findRoomConfig(topic) : undefined
  if (!rc) return // 只在 config.rooms 里登记过的群欢迎
  const names = invitees.map((c) => c.name()).join('、')
  const line = (config.welcome?.template || '欢迎 {新人} 加入！').replace('{新人}', names)
  await room.say(line).catch((e) => logger.error(`欢迎语发送失败: ${e.message}`))
  logger.info(`群[${topic}] 新成员 ${names} 进群，已发送欢迎语`)
}
