import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_FILE } from './runtime-paths.js'

/** 统一加载 config.json（UTF-8），全项目共用这一份 */
export function loadConfig(file = CONFIG_FILE) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象')
  return value
}
const config = loadConfig()

export default config

/** 按群对象、群名或群ID查找该群的具体配置；没有返回 undefined（走默认值） */
export function findRoomConfig(topicOrRoom, roomId = '') {
  let topic = ''
  let id = roomId
  if (topicOrRoom && typeof topicOrRoom === 'object') {
    id = topicOrRoom.id || id
    topic = topicOrRoom._topic || ''
  } else if (typeof topicOrRoom === 'string') {
    if (topicOrRoom.endsWith('@chatroom')) {
      id = topicOrRoom
    } else {
      topic = topicOrRoom
    }
  }

  const rooms = Array.isArray(config.rooms) ? config.rooms : []
  // An explicit ID never falls back to another configured ID with the same title.
  if (id) {
    const exact = rooms.find((r) => r?.id === id)
    if (exact) return exact
  }
  const named = rooms.filter((r) => r && !r.id && topic && r.topic === topic)
  return named.length === 1 ? named[0] : undefined
}
