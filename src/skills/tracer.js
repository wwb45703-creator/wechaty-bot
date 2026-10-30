import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataPath } from '../runtime-paths.js'
import { createSkillCandidate, proposeBundledExample, removeCandidatesFromTraces } from './review-store.js'

const traceDir = () => dataPath('state', 'proposals')
const lastRecorded = new Map()
const hash = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex')
const ref = (kind, value) => hash(`${kind}:${value || ''}`)
export function scopeReferences(scope) {
  if (!scope?.accountId || !scope?.subjectId || !scope?.conversationId || !scope?.personaId) return null
  return { platform: scope.platform || 'wechat', accountRef: ref('account', scope.accountId), conversationRef: ref('conversation', scope.conversationId), personaRef: ref('persona', scope.personaId), subjectRef: ref('subject', scope.subjectId) }
}
export function isUserCorrection(text) {
  return typeof text === 'string' && /不对|你搞错了|不是这样|换个方法|应该用|别用这个|改成|不要回这么长|不要分段/.test(text)
}
function classify({ userText = '', correction = '', errorMessage = '' }) {
  const correctionText = `${userText} ${correction}`
  if (/不要回这么长|简短|短一点/.test(correctionText)) return 'reply-length'
  if (/不要分段/.test(correctionText)) return 'reply-format'
  if (/SSRF|内网|地址不允许|地址.*拒绝/i.test(errorMessage)) return 'fetch-denied'
  if (/fetch|抓取|timeout|超时|403|404|429/i.test(errorMessage)) return 'fetch-failed'
  return errorMessage ? 'tool-failed' : 'correction'
}
export function recordInteractionTrace(payload = {}) {
  const scopeRefs = scopeReferences(payload.scope)
  if (!scopeRefs || (!payload.userText && !payload.errorMessage && !payload.correction)) return null
  const key = hash(JSON.stringify(scopeRefs))
  const now = Date.now()
  if (now - (lastRecorded.get(key) || 0) < 30000) return null
  lastRecorded.set(key, now)
  if (lastRecorded.size > 1000) lastRecorded.delete(lastRecorded.keys().next().value)
  const id = `trace_${crypto.randomUUID()}`
  // Classification is computed in memory. No raw text, names, URLs or error
  // messages enter this durable record, even when they contain secrets.
  const trace = { version: 2, id, timestamp: new Date(now).toISOString(), scopeRefs, category: classify(payload), action: ['safe_fetch', 'reach_search', 'conversation'].includes(payload.actionName) ? payload.actionName : 'tool', status: 'pending_review' }
  fs.mkdirSync(traceDir(), { recursive: true })
  fs.writeFileSync(path.join(traceDir(), `${id}.json`), JSON.stringify(trace, null, 2), 'utf8')
  return trace
}
export function listInteractionTraces() {
  if (!fs.existsSync(traceDir())) return []
  return fs.readdirSync(traceDir()).filter((n) => /^trace_[a-zA-Z0-9_-]+\.json$/.test(n)).map((n) => {
    try { const t = JSON.parse(fs.readFileSync(path.join(traceDir(), n), 'utf8')); return t.version === 2 ? t : null } catch { return null }
  }).filter(Boolean).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 200)
}
export function generateCandidateFromTrace(traceId) {
  const trace = listInteractionTraces().find((t) => t.id === traceId)
  if (!trace) throw new Error('来源轨迹不存在')
  if (trace.category === 'fetch-failed') return proposeBundledExample('jina-doc-reader', { kind: 'trace-template', traceId, category: trace.category })
  if (!['reply-length', 'reply-format'].includes(trace.category)) throw new Error('此分类没有安全模板，请人工分析；不会自动生成代码或正则')
  return createSkillCandidate({ id: 'concise-reply', name: '简短单条回复', description: '由纠错分类生成的保守模板；不是模型自主训练', triggers: ['不要回这么长|不要分段|短一点'], sop: '当对方明确要求简短或单条时，用一至两句回应当前问题，保持事实完整。复杂问题可以先给重点，避免机械连发。' }, { kind: 'trace-template', traceId, category: trace.category })
}
export function purgeSubjectTraces(scope, { allConversations = false } = {}) {
  const target = scopeReferences(scope)
  if (!target) return { removed: 0 }
  let removed = 0
  const errors = []
  // Do not use the UI's 200-item presentation limit for deletion.
  let names = []
  try { names = fs.readdirSync(traceDir()) } catch (error) { if (error.code !== 'ENOENT') errors.push(error) }
  for (const name of names) {
    if (!/^trace_[a-zA-Z0-9_-]+\.json$/.test(name)) continue
    const file = path.join(traceDir(), name)
    let trace
    try {
      trace = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) { if (error.code !== 'ENOENT') errors.push(error); continue }
    const r = trace.scopeRefs
    if (!r || r.platform !== target.platform || r.accountRef !== target.accountRef || r.subjectRef !== target.subjectRef || (!allConversations && r.conversationRef !== target.conversationRef)) continue
    try {
      // Keep this attribution until dependent files are gone. The review-store
      // also keeps an intent if just one of a candidate/evaluation pair fails.
      removeCandidatesFromTraces([...new Set([name.slice(0, -5), trace.id].filter((id) => typeof id === 'string' && /^trace_[a-zA-Z0-9_-]+$/.test(id)))])
      fs.unlinkSync(file)
      removed++
    } catch (error) { if (error.code !== 'ENOENT') errors.push(error) }
  }
  lastRecorded.clear()
  if (errors.length) throw new AggregateError(errors, '轨迹和候选清理尚未完成，请重试遗忘')
  return { removed }
}
