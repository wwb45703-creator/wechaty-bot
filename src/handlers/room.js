import config from '../config-loader.js'
import { processMessage, admitMessage, accountIdFor } from '../messaging.js'
import { produceTextResponse, isForgetCommand, isAllForget } from './text-response.js'
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
  if (talker?.self?.() || (talker?.id && talker.id === w?.currentUser?.id)) {
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

export async function handleRoomMessage(msg, room, admission = null) {
  const a = admission || await admitMessage(msg, room)
  if (!a) return
  const trigger = a.trigger || await checkRoomTrigger(msg, msg.text?.() || '', a.rc)
  const question = cleanMention(msg.text?.() || '', trigger.selfName, a.rc)
  const shortcut = isForgetCommand(question) || question === '我的记忆' || (config.dingDong && question.toLowerCase() === 'ding') || (config.menu?.enabled && question === config.menu?.keyword)
  if (!trigger.triggered && !shortcut) return
  a.shouldAt = a.rc?.atSender === true || (a.rc?.atSender !== false && trigger.triggerReason === 'mention')
  return processMessage({ msg, room, admission: a, kind: 'text', forget: isForgetCommand(question), allConversations: isAllForget(question),
    producer: (ctx) => produceTextResponse(ctx, question) })
}

export async function handleRoomJoin(room, invitees) {
  if (!config.welcome?.enabled || !invitees?.length) return
  const bot = room.wechaty
  const talker = invitees[0]
  const msg = { id: `join:${room.id}:${invitees.map((x) => x.id).sort().join(',')}:${Math.floor(Date.now() / 60000)}`,
    wechaty: bot, talker: () => talker, text: () => '', self: () => false }
  const a = await admitMessage(msg, room)
  if (!a) return
  const names = invitees.map((c) => c.name()).join('、')
  return processMessage({ msg, room, admission: a, kind: 'welcome', producer: async () => ({
    text: (config.welcome?.template || '欢迎 {新人} 加入').replace('{新人}', names), learn: false }) })
}
