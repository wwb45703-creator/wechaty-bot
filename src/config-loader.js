import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(__dirname, '..', 'config.json')

/** 统一加载 config.json（UTF-8），全项目共用这一份 */
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))

export default config

/** 按群名查找该群的具体配置；没有返回 undefined（走默认值） */
export function findRoomConfig(topic) {
  return (config.rooms || []).find((r) => r.topic === topic)
}
