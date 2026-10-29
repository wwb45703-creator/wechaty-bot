/**
 * 多气泡发送与拟人化文本净化工具：
 * 1. 把 AI 的多段回复拆成多条微信消息，加随机延迟逐条发出
 * 2. 彻底清洗乱码、控制字符、Unicode 替换符、句末孤立多余括号与死板句号
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 文本清洗与去乱码、去句末多余括号：
 * 1. 清理控制字符、不可见零宽字符、Unicode 替换字符 (\uFFFD)、孤立代理对（防乱码/问号）；
 * 2. 剥离整段外层成对包裹的括号（如 "(xxx)"、"（xxx）"、"【xxx】"）；
 * 3. 剥离句末未闭合的孤立左括号及截断内容（如 "你好("、"好的。（傲娇"）；
 * 4. 剥离句首/句末未配对的孤立右括号（如 ")好的"、"怎么了？)"）；
 * 5. 剥离句末死板句号与连续多余空格（契合微信打字留白风格）；
 * 6. 剥离角色扮演心理/动作括号描述（如 "(翻白眼)"、"（叹气）"）。
 */
export function cleanBubbleText(text) {
  if (!text || typeof text !== 'string') return ''
  let s = text

  // 1. 先移除 ANSI 终端控制码（形如 \x1B[31m）
  s = s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
  // 移除控制字符与不可见干扰字符（保留常见中英文标点、换行与空格）
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  // 移除 Unicode 替换字符 (U+FFFD) 与零宽干扰字符/BOM
  s = s.replace(/[\uFFFD\uFEFF\u200B\u200C\u200D\u200E\u200F]/g, '')
  // 规整孤立代理对 (Lone Surrogates，防 Windows 客户端转换 wchar 出现乱码)
  if (typeof s.toWellFormed === 'function') {
    s = s.toWellFormed().replace(/\uFFFD/g, '')
  } else {
    s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
  }

  // 2. 剥离角色扮演常见的动作/神态/心理活动括号标注（如 “(转头)”、“(翻白眼)”、“（轻咳）”、“(傲娇)”）
  s = s.replace(/[\(（\[【]\s*(?:转头|翻白眼|微笑|叹气|得意|冷笑|小声|傲娇|撇嘴|摊手|歪头|扶额|盯——?|轻笑|脸红|哼一声|思考状|无语|耸肩|抓狂|大哭|狂笑)\s*[\)）\]】]/g, '')

  // 3. 剥离整段最外层成对包裹的括号（例如模型把整句包在括号里）
  s = s.trim()
  while (
    (s.startsWith('(') && s.endsWith(')')) ||
    (s.startsWith('（') && s.endsWith('）')) ||
    (s.startsWith('【') && s.endsWith('】')) ||
    (s.startsWith('[') && s.endsWith(']')) ||
    (s.startsWith('{') && s.endsWith('}'))
  ) {
    s = s.slice(1, -1).trim()
  }

  // 4. 剥离句末未闭合的孤立左括号及后续截断内容（如 "怎么了？(" 或 "行吧。（傲娇转头"）
  s = s.replace(/[\(（\[【\{《「][^)）\]】\}》」]*$/g, '').trim()

  // 5. 剥离句首未成对的孤立右括号（如 ")今天有事" 或 "）行吧"）
  s = s.replace(/^[\)）\]】\}》」]+/g, '').trim()

  // 6. 剥离句末未配对的孤立右括号（例如句子开头没有左括号，但末尾挂了右括号）
  while (/[\)）\]】\}》」]$/.test(s)) {
    const lastChar = s[s.length - 1]
    const openChar = { ')': '(', '）': '（', ']': '[', '】': '【', '}': '{', '》': '《', '」': '「' }[lastChar]
    if (openChar && !s.includes(openChar)) {
      s = s.slice(0, -1).trim()
    } else {
      break
    }
  }

  // 7. 剥离末尾死板句号与连续多余空格/标点残留
  s = s.replace(/[。 \t]+$/g, '').trim()

  // 8. 二次收敛：若去掉末尾句号后暴露出了新的孤立左括号或右括号，循环收尾
  s = s.replace(/[\(（\[【\{《「\s]+$/g, '').trim()
  while (/[\)）\]】\}》」]$/.test(s)) {
    const lastChar = s[s.length - 1]
    const openChar = { ')': '(', '）': '（', ']': '[', '】': '【', '}': '{', '》': '《', '」': '「' }[lastChar]
    if (openChar && !s.includes(openChar)) {
      s = s.slice(0, -1).trim()
    } else {
      break
    }
  }
  s = s.replace(/[。 \t]+$/g, '').trim()

  return s
}

/**
 * 拆分回复为多条气泡：
 * 1. 按 ||| 分隔（AI 显式连发意图）
 * 2. 各段内的换行也视为分条（对话式内容逐条连发更有活人感）
 * 3. 对每段气泡执行 cleanBubbleText，杜绝句末多余括号与乱码
 * 超过 max 条时，多余部分合并为最后一条（换行连接），不丢内容
 */
export function splitBubbles(text, max = 3) {
  let raw = String(text || '').trim()

  // 先处理模型在 ||| 连发标记外裹挟的括号形态，如 "(|||" 或 "|||)"
  raw = raw.replace(/[\(（]\s*\|\|\|\s*[\)）]/g, ' ||| ')
  raw = raw.replace(/[\(（]\s*\|\|\|/g, ' ||| ')
  raw = raw.replace(/\|\|\|\s*[\)）]/g, ' ||| ')

  // 整体首尾如果是成对括号包裹，先解包外层
  while (
    (raw.startsWith('(') && raw.endsWith(')')) ||
    (raw.startsWith('（') && raw.endsWith('）')) ||
    (raw.startsWith('【') && raw.endsWith('】')) ||
    (raw.startsWith('[') && raw.endsWith(']'))
  ) {
    raw = raw.slice(1, -1).trim()
  }

  const lines = raw
    .split('|||')
    .flatMap((s) => s.split(/\n+/))
    .map((s) => cleanBubbleText(s))
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
  const list = Array.isArray(texts) && texts.length > 0 ? texts : []
  let sentCount = 0
  for (let i = 0; i < list.length; i++) {
    const item = cleanBubbleText(String(list[i] || ''))
    if (!item) continue
    if (sentCount > 0) await sleep(400 + Math.random() * 300)
    await send(item, sentCount)
    sentCount++
  }
}
