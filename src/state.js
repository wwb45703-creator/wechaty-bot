/**
 * 人设切换状态持久化：每个群/每个私聊好友独立记录当前激活的角色卡。
 * 文件：state/personas.json（.gitignore 已排除 state/？——state 含群偏好，不入库）
 * 结构：{ "rooms": { "<roomId>": "角色名" }, "private": { "<wxid>": "角色名" } }
 */
import fs from 'node:fs'
import path from 'node:path'
import { dataPath } from './runtime-paths.js'
import { getMigrationInfo } from './social/index.js'

const FILE = dataPath('state', 'personas.json')

let cache = null

function loadState() {
  if (cache) return cache
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    cache = {
      rooms: data.rooms && typeof data.rooms === 'object' ? data.rooms : {},
      private: data.private && typeof data.private === 'object' ? data.private : {},
      accounts: data.accounts && typeof data.accounts === 'object' ? data.accounts : {},
    }
  } catch {
    cache = { rooms: {}, private: {}, accounts: {} }
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
  const migration = ref.accountId ? getMigrationInfo() : null
  const migrated = migration?.accountId === ref.accountId ? migration.roleMapping : null
  const group = ref.accountId ? s.accounts[ref.accountId] : s
  const name = ref.scope === 'room' ? group?.rooms?.[ref.roomId] : group?.private?.[ref.userId]
  const original = ref.scope === 'room' ? migrated?.rooms?.[ref.roomId] : migrated?.private?.[ref.userId]
  const overrides = ref.scope === 'room' ? group?.rooms : group?.private
  const key = ref.scope === 'room' ? ref.roomId : ref.userId
  return overrides && Object.hasOwn(overrides, key) ? (name || fallback) : original || fallback
}

export function setPersonaName(ref, name) {
  const s = loadState()
  const group = ref.accountId ? (s.accounts[ref.accountId] ||= { rooms: {}, private: {} }) : s
  if (ref.scope === 'room') group.rooms[ref.roomId] = name
  else group.private[ref.userId] = name
  saveState()
}

export function clearPersona(ref) {
  const s = loadState()
  const group = ref.accountId ? s.accounts[ref.accountId] : s
  // Empty overrides are explicit resets; absence still inherits a frozen migration selection.
  if (ref.accountId) {
    const target = s.accounts[ref.accountId] ||= { rooms: {}, private: {} }
    if (ref.scope === 'room') target.rooms[ref.roomId] = ''
    else target.private[ref.userId] = ''
  } else if (ref.scope === 'room' && group?.rooms) delete group.rooms[ref.roomId]
  else if (group?.private) delete group.private[ref.userId]
  saveState()
}
