/**
 * 人设切换状态持久化：每个群/每个私聊好友独立记录当前激活的角色卡。
 * 文件：state/personas.json（.gitignore 已排除 state/？——state 含群偏好，不入库）
 * 结构：{ "rooms": { "<roomId>": "角色名" }, "private": { "<wxid>": "角色名" } }
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FILE = path.join(__dirname, '..', 'state', 'personas.json')

let cache = null

function loadState() {
  if (cache) return cache
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    cache = {
      rooms: data.rooms && typeof data.rooms === 'object' ? data.rooms : {},
      private: data.private && typeof data.private === 'object' ? data.private : {},
    }
  } catch {
    cache = { rooms: {}, private: {} }
  }
  return cache
}

function saveState() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8')
  fs.renameSync(tmp, FILE)
}

/** ref: { scope: 'room', roomId } 或 { scope: 'private', userId } */
export function getPersonaName(ref, fallback = '') {
  const s = loadState()
  const name = ref.scope === 'room' ? s.rooms[ref.roomId] : s.private[ref.userId]
  return name || fallback
}

export function setPersonaName(ref, name) {
  const s = loadState()
  if (ref.scope === 'room') s.rooms[ref.roomId] = name
  else s.private[ref.userId] = name
  saveState()
}

export function clearPersona(ref) {
  const s = loadState()
  if (ref.scope === 'room') delete s.rooms[ref.roomId]
  else delete s.private[ref.userId]
  saveState()
}
