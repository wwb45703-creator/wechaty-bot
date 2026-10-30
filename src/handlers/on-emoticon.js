import config from '../config-loader.js'
import { processMessage } from '../messaging.js'

const lines = ['这个表情挺传神😂', '哈哈，这张图我看懂了', '6，这表情很有精神', '这小表情有点意思']
const previous = new Map()
export function isEmoticonEnabled() { return config.emoticon?.enabled !== false }
export async function handleEmoticonMessage(msg, room, admission = null) {
  if (!isEmoticonEnabled()) return
  return processMessage({ msg, room, admission, kind: 'emoticon', producer: async (ctx) => {
    const available = lines.filter((x) => x !== previous.get(ctx.key))
    const text = available[Math.floor(Math.random() * available.length)]
    previous.set(ctx.key, text)
    return { text, userText: '发了一个表情包', extract: false }
  } })
}
