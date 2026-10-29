/**
 * room-directives.js — 群聊用户指令与约定记忆模块
 *
 * 功能：
 *  1. 识别并捕获群成员在群聊中向机器人下达的口吻/称谓/说话约定/规则指令（如“每句话加个喵字”、“以后叫我主人”、“不要提xx”）；
 *  2. 结构化持久化到 state/room-directives/<safeRoomId>.json（每群保留最新 5~8 条，FIFO 滑动窗口）；
 *  3. 格式化为注入 System Prompt 的人设提示词引导，使机器人在群聊中牢记并切实遵循群友指令；
 *  4. 支持群内快捷指令：“查看群指令”（列出当前生效指令）与“重置群指令”（清空本群指令）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../logger.js'

const DIRECTIVES_DIR = path.join(process.cwd(), 'state', 'room-directives')

// 识别群友口吻/人设/行为约定指令的高频正则模式
const DIRECTIVE_PATTERNS = [
  // 1. 显式时间与时态约定（“以后跟我说话...”、“从现在开始...”）
  /(?:以后|从现在开始|今后|以后跟我|跟我说话|跟我聊天)(?:都|必须|要|请|麻烦)?(.{2,40})/i,
  // 2. 行为要求与祈使指令（“请你把...”、“你必须...”）
  /(?:请你|麻烦你|你要|你必须|必须|务必)(?:把|在|将|给|在之后|之后)?(.{2,40})/i,
  // 3. 词尾/词首口头禅约定（“每句话后面加...”、“每次说话带上...”）
  /(?:每句话|每次回复|每次说话|所有回复)(?:后面|前面|前后|都|加|带)?(.{2,30})/i,
  // 4. 记忆指令（“记住...”、“给我牢记...”）
  /(?:记住|牢记|帮我记住|给我记住)(?:，|：|:|\s)?(.{2,40})/i,
  // 5. 禁令与限制指令（“不要再提...”、“别在群里...”）
  /(?:不要再|别再|严禁|不准|不能再|禁止)(?:在群里|跟我|说|提|发)?(.{2,30})/i,
  // 6. 称谓与昵称约定（“叫我主人”、“称呼我浩哥”）
  /(?:叫我|称呼我|管我叫)(?:，|：|:|\s)?(.{1,15})/i,
  // 7. 身份与人设调整（“从现在开始你是个猫娘”、“人设变成高冷”）
  /(?:人设变成|你现在是|从现在开始你是|你的身份是)(?:，|：|:|\s)?(.{2,30})/i,
  // 8. 纠正与限定指令（“只要叫主人就行”、“改成叫小明”）
  /(?:只要|只准|只许|只用|改叫|改成)(?:叫|说|回复|带|加)?(.{1,25})/i,
]

function getSafeFile(roomId) {
  const safeId = String(roomId || 'default').replace(/[\\/:*?"<>|]/g, '_')
  return path.join(DIRECTIVES_DIR, `${safeId}.json`)
}

/** 读取指定群的生效指令列表 */
export function getRoomDirectives(roomId) {
  if (!roomId) return []
  const file = getSafeFile(roomId)
  try {
    if (!fs.existsSync(file)) return []
    const content = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(content)
    return Array.isArray(parsed?.directives) ? parsed.directives : []
  } catch (e) {
    logger.warn(`[room-directives] 读取群指令异常 [${roomId}]: ${e.message}`)
    return []
  }
}

/** 保存群指令列表（原子写入） */
function saveRoomDirectives(roomId, directives) {
  if (!roomId) return
  fs.mkdirSync(DIRECTIVES_DIR, { recursive: true })
  const file = getSafeFile(roomId)
  const tmp = `${file}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ roomId, directives, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    logger.error(`[room-directives] 写入群指令失败 [${roomId}]: ${err.message}`)
  }
}

/** 清空指定群的所有指令与约定 */
export function clearRoomDirectives(roomId) {
  if (!roomId) return false
  const file = getSafeFile(roomId)
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return true
  } catch (e) {
    logger.error(`[room-directives] 清除群指令失败 [${roomId}]: ${e.message}`)
    return false
  }
}

/** 探测文本中是否包含用户对机器人的口吻/行为约定指令，若有则返回规范化的指令内容 */
export function captureDirectiveFromText(text) {
  if (!text || typeof text !== 'string') return null
  const t = text.trim()
  if (t.length < 3 || t.length > 80) return null

  // 排除单纯的疑问句（如“你觉得这样对吗？”、“什么时候开始？”）
  if (/^[？?吗呢什么谁哪为什么怎么]/.test(t) && !/(?:请你|记住|以后)/.test(t)) {
    return null
  }

  for (const pat of DIRECTIVE_PATTERNS) {
    if (pat.test(t)) {
      return t
    }
  }
  return null
}

/**
 * 记录一条群友指令或约定（同群同用户更新，跨用户追加，最大保留 6 条）
 */
export function recordRoomDirective(roomId, talkerName, directiveText) {
  if (!roomId || !directiveText) return false
  const cleanDirective = String(directiveText).trim().slice(0, 80)
  const user = String(talkerName || '群友').trim()

  const list = getRoomDirectives(roomId)

  // 检查该用户是否已有旧约定，若有且语义高度相近则覆盖更新，否则作为最新约定追加
  const existingIndex = list.findIndex((d) => d.userName === user)
  const newItem = {
    userName: user,
    text: cleanDirective,
    updatedAt: new Date().toLocaleTimeString('sv-SE', { timeZone: 'Asia/Shanghai' }),
  }

  if (existingIndex >= 0) {
    list[existingIndex] = newItem
  } else {
    list.push(newItem)
  }

  // FIFO 上限保护：最多保留最新 6 条群指令，避免 Prompt 膨胀
  while (list.length > 6) {
    list.shift()
  }

  saveRoomDirectives(roomId, list)
  logger.info(`[room-directives] 成功记住群指令 [群:${roomId}] ${user} -> "${cleanDirective}"`)
  return true
}

/**
 * 格式化为注入 System Prompt 的群友约定提示词引导
 */
export function formatRoomDirectivesPrompt(roomId) {
  const list = getRoomDirectives(roomId)
  if (!list || list.length === 0) return ''

  const lines = list.map((item, idx) => `${idx + 1}. [群友 ${item.userName} 约定]：“${item.text}”`)

  return `【本群专属群友指令与约定（最高优先级要求）】
当前微信群的群友对你提出了以下明确要求、称谓习惯或对话约定，你在本群的所有发言中必须时刻牢记并切实执行：
${lines.join('\n')}
注意：群友提出的对话要求是最高行为准则，无论如何必须切实执行（如加指定口头禅、特定称谓、避开某些话题等），绝不可违背或遗忘！`
}
