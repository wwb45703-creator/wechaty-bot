/**
 * test-room-trigger.mjs — 群聊免 @ 触发与意图清洗专项测试
 *
 * 覆盖场景：
 *  1. mode="all" 全量免 @ 模式触发
 *  2. mode="mention" 被 @ 触发与非 @ 忽略
 *  3. wakeWords 自然唤醒词触发
 *  4. prefixes 符号指令前缀触发（? / ？ / ! / /）
 *  5. smartQuestion 智能疑问句与求助意图探测
 *  6. cleanMention 提及噪音、唤醒词及前缀符号清洗
 *  7. 机器人自身发言绝对阻断（杜绝回声死循环）
 *
 * 用法：node scripts/test-room-trigger.mjs
 */

import { checkRoomTrigger, cleanMention, isQuestionIntent } from '../src/handlers/room.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ' → ' + detail : ''}`)
  cond ? pass++ : fail++
}

function mockMsg({ text = '', self = false, talkerName = '群友张三', botName = '测试机器人' }) {
  return {
    text: () => text,
    talker: () => ({
      name: () => talkerName,
      self: () => self,
    }),
    mentionSelf: async () => text.includes(`@${botName}`),
    wechaty: {
      currentUser: { name: () => botName },
      userSelf: () => ({ name: () => botName }),
    },
  }
}

// ---- 1. 全量免 @ 模式 (mode="all") ----
const msgAll = mockMsg({ text: '大家吃晚饭了吗' })
const resAll = await checkRoomTrigger(msgAll, '大家吃晚饭了吗', { mode: 'all' })
ok('mode="all" 全量免 @ 触发', resAll.triggered === true && resAll.triggerReason === 'mode:all')

// ---- 2. mention 模式 ----
const msgAt = mockMsg({ text: '@测试机器人 你好呀' })
const resAt = await checkRoomTrigger(msgAt, '@测试机器人 你好呀', { mode: 'mention' })
ok('mention 模式包含 @机器人 正常触发', resAt.triggered === true && resAt.triggerReason === 'mention')

const msgNoAt = mockMsg({ text: '今天天气不错' })
const resNoAt = await checkRoomTrigger(msgNoAt, '今天天气不错', { mode: 'mention' })
ok('mention 模式普通发言不触发', resNoAt.triggered === false)

// ---- 3. wakeWords 唤醒词模式 ----
const msgWake = mockMsg({ text: '小助手 查一下汇率' })
const resWake = await checkRoomTrigger(msgWake, '小助手 查一下汇率', { wakeWords: ['小助手', '小猫'] })
ok('包含唤醒词触发', resWake.triggered === true && resWake.triggerReason === 'wake:小助手')

// ---- 4. prefixes 符号前缀模式 ----
const msgPrefix1 = mockMsg({ text: '？今天北京天气如何' })
const resPrefix1 = await checkRoomTrigger(msgPrefix1, '？今天北京天气如何', { prefixes: ['?', '？', '!', '/'] })
ok('中文问号前缀触发', resPrefix1.triggered === true && resPrefix1.triggerReason === 'prefix:？')

const msgPrefix2 = mockMsg({ text: '/help' })
const resPrefix2 = await checkRoomTrigger(msgPrefix2, '/help', { prefixes: ['?', '？', '!', '/'] })
ok('斜杠指令前缀触发', resPrefix2.triggered === true && resPrefix2.triggerReason === 'prefix:/')

const msgPrefixNone = mockMsg({ text: '我不同意这个看法' })
const resPrefixNone = await checkRoomTrigger(msgPrefixNone, '我不同意这个看法', { prefixes: ['?', '？', '!', '/'] })
ok('无指定前缀时不触发', resPrefixNone.triggered === false)

// ---- 5. smartQuestion 智能疑问句探测 ----
ok('问号结尾判定为疑问句', isQuestionIntent('有人知道附近哪个火锅好吃吗？') === true)
ok('带求助词判定为疑问句', isQuestionIntent('请问 Python 怎么安装依赖') === true)
ok('带疑问代词判定为疑问句', isQuestionIntent('为什么今天股市大涨') === true)
ok('带判断疑问词判定为疑问句', isQuestionIntent('明天会不会下雨呢') === true)
ok('陈述句不被误判为疑问句', isQuestionIntent('今天中午吃了牛肉面') === false)
ok('短消息不触发疑问句（防感叹或单字误判）', isQuestionIntent('在吗？') === false)

const msgSmartQ = mockMsg({ text: '有人知道这道数学题怎么解吗' })
const resSmartQ = await checkRoomTrigger(msgSmartQ, '有人知道这道数学题怎么解吗', { smartQuestion: true })
ok('smartQuestion 开启时真实提问触发', resSmartQ.triggered === true && resSmartQ.triggerReason === 'smartQuestion')

// ---- 6. cleanMention 文本清洗 ----
const rcConfig = { wakeWords: ['小助手'], prefixes: ['？', '?'] }
ok('清洗 @机器人 标签', cleanMention('@测试机器人 明天会下雨吗', '测试机器人', rcConfig) === '明天会下雨吗')
ok('清洗句首唤醒词', cleanMention('小助手 推荐一部动漫', '测试机器人', rcConfig) === '推荐一部动漫')
ok('清洗符号前缀', cleanMention('？上证指数多少', '测试机器人', rcConfig) === '上证指数多少')

// ---- 7. 机器人自身发言绝对阻断（防死循环） ----
const msgSelf1 = mockMsg({ text: '大家吃晚饭了吗', self: true })
const resSelf1 = await checkRoomTrigger(msgSelf1, '大家吃晚饭了吗', { mode: 'all' })
ok('自身发言（self=true）绝对阻断', resSelf1.triggered === false)

const msgSelf2 = mockMsg({ text: '小助手 在吗', talkerName: '测试机器人' })
const resSelf2 = await checkRoomTrigger(msgSelf2, '小助手 在吗', { wakeWords: ['小助手'] })
ok('自身发言（同名拦截）绝对阻断', resSelf2.triggered === false)

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
