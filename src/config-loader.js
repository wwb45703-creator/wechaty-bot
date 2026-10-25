import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(__dirname, '..', 'config.json')

/** 统一加载 config.json（UTF-8），全项目共用这一份 */
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

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

  return (config.rooms || []).find((r) => {
    if (id && r.id && r.id === id) return true
    if (topic && r.topic && r.topic === topic) return true
    return false
  })
}
