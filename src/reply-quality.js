import { cleanBubbleText, formatBotReply, textSimilarity, stripAtMentions } from './utils.js'

export const normalizeReply = text => formatBotReply(stripAtMentions(cleanBubbleText(String(text || '')))).replace(/\|\|\||[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
const compact = text => String(text || '').replace(/[\s\p{P}]/gu, '')
const numbers = text => [...String(text).matchAll(/\d+(?:\.\d+)?/g)].map(m => m[0]).join('|')
const numericClaims = text => [...String(text).matchAll(/\d{4}[-/]\d{1,2}[-/]\d{1,2}|v?\d+\.\d+(?:\.\d+)?|\d+\s*(?:原石|星琼|菲林|点券|星声|金币|年|月|日|号|点|时|分|元|抽|次|天|个|级|%|钻|券)?/gi)]
  .map(match => match[0].toLowerCase().replace(/\s/g, '').replace(/^v/, '').replace(/^(\d+)号$/, '$1日'))
function supportedNumericClaims(text, evidence) {
  const claims = new Set(numericClaims(evidence))
  for (const match of evidence.matchAll(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g)) {
    claims.add(`${Number(match[1])}年`); claims.add(`${Number(match[2])}月`); claims.add(`${Number(match[3])}日`)
  }
  return numericClaims(text).every(claim => claims.has(claim))
}

export function validateReply(raw, { recent = [], system = '', research, maxChars = 50, userText = '', functional = false } = {}) {
  const text = normalizeReply(raw), issues = []
  if (!text) issues.push('empty')
  if (functional) return { ok: Boolean(text), text, issues }
  if ([...text].length > maxChars) issues.push('too-long')
  if (/[？?]/.test(raw) || /(?:你|您).{0,16}(?:吗|呢|么)[。！!\s]*$|^(?:为什么|为何|你觉得|你怎么看|要不要|有没有|是不是)/u.test(text)) issues.push('question')
  if (/(.{3,14})[，,。!！\s]+\1/u.test(text)) issues.push('internal-repeat')
  if (text.split(/[。！!；;]/).filter(part => part.trim()).length > 2) issues.push('too-many-sentences')
  if (/(?:傻[逼比]|蠢货|废物|滚蛋|智障)/.test(text)) issues.push('hostile-tone')
  const normalized = compact(text), identityQuestion = /(?:你(?:叫|是|的名字|的性别|的爱好)|介绍(?:你自己|一下自己))/.test(userText)
  if (!identityQuestion && /(?:我叫|我的名字是|我的性格是|我是(?:群里的)?(?:AI|机器人|鹅王)|鹅王是个)/i.test(text)) issues.push('unsolicited-identity')
  if (normalized.length >= 8 && normalized === compact(userText)) issues.push('input-echo')
  if (!identityQuestion && recent.slice(-5).some(previous => {
    if (normalized !== compact(previous) && numbers(text) !== numbers(previous)) return false
    return normalized === compact(previous) || (normalized.length >= 12 && compact(previous).length >= 12 && textSimilarity(text, previous) >= 0.80)
  })) issues.push('recent-repeat')
  const opener = text.match(/^(确实|说白了|只能说|这波属于|可以这么说|简单来说|说实话)/)?.[0]
  if (opener && recent.slice(-5).filter(previous => previous.startsWith(opener)).length >= 2) issues.push('stock-opener')
  if (normalized.length >= 20 && system) {
    const policy = compact(system)
    if ([policy.slice(0, 20), policy.slice(Math.floor(policy.length * 0.45), Math.floor(policy.length * 0.45) + 20)].some(probe => probe.length >= 12 && normalized.includes(probe))) issues.push('rule-echo')
  }
  if (research && research.status !== 'skipped') {
    const evidence = research.facts || ''
    if (!supportedNumericClaims(text, evidence)) issues.push('unsupported-number')
    if (research.status === 'unavailable' && !/(?:未|没|暂|不确定|不能确认|无法确认|不乱|不把|不拿|不提交|不说死|不下结论)/.test(text)) issues.push('unverified-claim')
  }
  return { ok: issues.length === 0, text, issues: [...new Set(issues)] }
}

export function unavailableReply(research, recent = []) {
  const variants = research.reason === 'missing-game-context'
    ? ['还没明确是哪款游戏，暂时不能确认活动细节', '缺少具体游戏信息，这个活动先不下结论']
    : research.reason === 'ambiguous-game-server'
      ? ['查到的活动分属不同区服，暂时不能混在一起说', '这几份公告的区服没有对上，活动细节暂不下结论']
    : research.reason === 'private-or-invalid-query'
      ? ['这条内容含个人信息，就不拿去公开搜索了', '先保留这段私人信息，不提交到公开搜索']
    : research.reason === 'conflicting-sources'
      ? ['查到的说法互相冲突，活动细节先不说死', '几份资料没有对上，暂时不把其中一份当定论']
      : research.kind === 'meme'
        ? ['这个说法的出处还没对上，先不乱接', '暂时没查实这个梗的语境，就不硬套了']
        : research.kind === 'game' ? ['还没查到可靠的当前公告，活动细节先不说死', '这条暂未查实，先不把传言当成确定消息']
          : ['暂时没查到能对上的近期资料，这条先不下定论', '这条暂未查实，先不把传言当成确定消息']
  return variants.find(text => !recent.slice(-5).includes(text)) || null
}
