/**
 * 长期记忆存储（模型无关）：纯结构化 JSON 落盘，任何模型读取的都是同一份文件。
 *
 * 目录结构：
 *   memories/private/<wxid>.json              私聊：一个人一份
 *   memories/rooms/<roomId>/<成员wxid>.json   群聊：每群每人一份（roomId 不随群改名变化）
 *
 * 文件 schema：
 *   { version, id, displayName, scope, room, updatedAt, facts: [ { date, text } ] }
 * facts 新的在后面；上限 MAX_FACTS，满了淘汰最旧的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', 'memories')
const MAX_FACTS = 50
const VERSION = 1

/** 记录每个文件的清空时间戳，防止异步提取完成后幽灵复活已删除的记忆 */
const clearedAt = new Map()
/** 记录每个文件的写入队列，串行化并发写入防并发覆写 Lost Update */
const writeQueues = new Map()

/** ref: { scope: 'private', userId } 或 { scope: 'room', roomId, userId } */
function fileFor(ref) {
  if (ref.scope === 'private') return path.join(ROOT, 'private', `${ref.userId}.json`)
  if (ref.scope === 'room') return path.join(ROOT, 'rooms', ref.roomId, `${ref.userId}.json`)
  throw new Error(`未知记忆 scope: ${ref.scope}`)
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase()
}

function loadMemory(ref, displayName = '') {
  const file = fileFor(ref)
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data && Array.isArray(data.facts)) {
      if (ref.displayName) data.displayName = ref.displayName // 昵称跟随最新
      return data
    }
  } catch {
    /* 不存在或损坏都重建 */
  }
  return {
    version: VERSION,
    id: ref.userId,
    displayName: displayName || ref.displayName || '',
    scope: ref.scope,
    room: ref.scope === 'room' ? (ref.roomTopic || ref.roomId) : null,
    updatedAt: new Date().toISOString(),
    facts: [],
  }
}

function saveMemory(ref, data) {
  const file = fileFor(ref)
  const tmp = `${file}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    data.updatedAt = new Date().toISOString()
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8') // 唯一临时文件+替换，防并发冲突与写坏
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    // 写盘失败（磁盘满/杀软占用 tmp 等）不能让调用方的后台链路崩掉进程
    try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
    console.error(`[memory] 写入失败 ${file}: ${err.message}`)
    return false
  }
}

function doAppendFacts(ref, texts, displayName, requestedAt) {
  const file = fileFor(ref)
  const lastCleared = clearedAt.get(file) || 0
  if (requestedAt <= lastCleared) {
    // 该提取任务是在清空记忆前发起的，放弃追加，防止已删记忆复活
    return 0
  }

  const clean = (texts || [])
    .map((t) => String(t || '').trim())
    .filter((t) => t.length >= 2 && t.length <= 200)
  if (clean.length === 0) return 0

  const data = loadMemory(ref, displayName)
  const seen = new Set(data.facts.map((f) => normalize(f.text)))
  const date = new Date().toISOString().slice(0, 10)
  let added = 0
  for (const text of clean) {
    if (seen.has(normalize(text))) continue
    data.facts.push({ date, text })
    seen.add(normalize(text))
    added++
  }
  if (added === 0) return 0
  if (data.facts.length > MAX_FACTS) data.facts = data.facts.slice(-MAX_FACTS)
  saveMemory(ref, data)
  return added
}

/** 追加长期记忆要点（串行写队列防并发；归一化去重；超上限淘汰最旧），返回实际新增条数 */
export async function appendFacts(ref, texts, displayName = '', requestedAt = Date.now()) {
  const file = fileFor(ref)
  const prev = writeQueues.get(file) || Promise.resolve()
  const task = prev.catch(() => {}).then(() => doAppendFacts(ref, texts, displayName, requestedAt))
  writeQueues.set(file, task)
  task.finally(() => {
    if (writeQueues.get(file) === task) writeQueues.delete(file)
  })
  return task
}

/** 生成注入 system prompt 的记忆文本块；没有记忆返回 '' */
export function formatForPrompt(ref, max = 15) {
  const data = loadMemory(ref)
  if (!data.facts.length) return ''
  const recent = data.facts.slice(-max)
  const lines = recent.map((f) => `- ${f.text}（${f.date}）`)
  return `你对这位用户的长期记忆（来自以往交流，仅供你自然地参考，绝不要主动复述这份列表本身）：\n${lines.join('\n')}`
}

/** 清空某人的记忆文件（"忘记我"命令） */
export function clearMemory(ref) {
  const file = fileFor(ref)
  clearedAt.set(file, Date.now())
  try {
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/** 读取原始记忆（"我的记忆"命令展示用） */
export function getMemory(ref) {
  return loadMemory(ref)
}

/** 记忆功能总开关（config.memory.enabled，默认开） */
let enabled = true
export function setMemoryEnabled(v) {
  enabled = Boolean(v)
}
export function isMemoryEnabled() {
  return enabled
}
