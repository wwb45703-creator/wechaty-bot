/**
 * 多气泡发送工具：把 AI 的多段回复拆成多条微信消息，加随机延迟逐条发出
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 拆分回复为多条气泡：
 * 1. 按 ||| 分隔（AI 显式连发意图）
 * 2. 各段内的换行也视为分条（对话式内容逐条连发更有活人感）
 * 超过 max 条时，多余部分合并为最后一条（换行连接），不丢内容
 */
export function splitBubbles(text, max = 3) {
  const lines = String(text || '')
    .split('|||')
    .flatMap((s) => s.split(/\n+/))
    .map((s) => s.trim())
    .filter(Boolean)
  if (lines.length <= max) return lines
  return [...lines.slice(0, max - 1), lines.slice(max - 1).join('\n')]
}

/**
 * 剥离回复内容中的 @ 提及（防止与代码添加的 @ 叠加成 "@xx @xx"）：
 *  1. 字面移除指定名字的 "@昵称"（说话人/机器人自己）
 *  2. 行首 AI 自行模仿的 "@某人" 序列一并剥掉
 */
export function stripAtMentions(text, names = []) {
  let t = String(text || '')
  for (const n of names) {
    if (n) t = t.split(`@${n}`).join('')
  }
  t = t.replace(/^(?:\s*@\S+\s*)+/gm, (m) => (m.includes('\n') ? '\n' : ''))
  t = t.replace(/@\s*(?=[，。！？、\s]|$)/g, '') // 清理剥离后残留的孤立 @
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 逐条发送气泡：先等一段"拟人延迟"，条间 400-700ms 随机延迟（模拟真人连发）
 * @param {(text: string, index: number) => Promise<void>} send 单条发送函数
 * @param {string[]} texts 已拆分的气泡列表
 * @param {[number, number]} [delayRange] 首条前的随机延迟区间（秒），如 [3, 4]
 */
export async function sendBubbles(send, texts, delayRange) {
  if (Array.isArray(delayRange) && delayRange.length === 2) {
    const [lo, hi] = delayRange
    await sleep((lo + Math.random() * (hi - lo)) * 1000)
  }
  const list = Array.isArray(texts) && texts.length > 0 ? texts : ['']
  for (let i = 0; i < list.length; i++) {
    if (i > 0) await sleep(400 + Math.random() * 300)
    await send(list[i], i)
  }
}
