import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dataPath } from '../runtime-paths.js'
import { compileSafeRegex, executeSkillPipeline, validateSkillDefinition } from './dsl-executor.js'

const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evolved')
const storePath = (...parts) => dataPath('state', 'skills', ...parts)
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const HASH = /^[a-f0-9]{64}$/
const EVALUATOR_VERSION = 'offline-fixtures-v1'
function read(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}
function assertId(id) { if (typeof id !== 'string' || !ID.test(id) || Object.hasOwn(Object.prototype, id)) throw new Error('无效的技能或候选编号'); return id }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
  return value
}
export function contentHash(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex') }
function audit(action, payload) {
  fs.mkdirSync(storePath(), { recursive: true })
  fs.appendFileSync(storePath('audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), action, ...payload }) + '\n')
}
function registry() { return read(storePath('registry.json'), { version: 1, active: {}, history: {} }) }
function validContent(content) {
  if (!content) throw new Error('技能元数据不完整')
  assertId(content.id)
  if (typeof content.name !== 'string' || content.name.length > 120 || typeof content.sop !== 'string' || content.sop.length > 6000) throw new Error('技能元数据不完整')
  if (!Array.isArray(content.triggers) || !content.triggers.length || content.triggers.length > 8) throw new Error('触发条件必须为 1～8 条')
  for (const t of content.triggers) compileSafeRegex(typeof t === 'string' ? t : t?.pattern, typeof t === 'string' ? 'i' : t.flags || 'i')
  if (content.executionPlan) { const v = validateSkillDefinition(content); if (!v.ok) throw new Error(v.error) }
}
function candidateFile(id) { return storePath('candidates', `${assertId(id)}.json`) }
export function getSkillReview(id) {
  const candidate = read(candidateFile(id))
  if (!candidate) throw new Error('候选不存在')
  const reg = registry()
  const prior = reg.active[candidate.content.id] ? loadApprovedVersion(candidate.content.id, reg.active[candidate.content.id]) : null
  return { ...candidate, evaluation: read(storePath('evaluations', `${id}.json`)), activeHash: reg.active[candidate.content.id] || null, previous: prior?.content || null }
}
export function createSkillCandidate(content, source = {}) {
  validContent(content)
  // Sources contain identifiers only. Never accept a raw message or a user name here.
  const sources = { kind: ['bundled-example', 'trace-template', 'manual'].includes(source.kind) ? source.kind : 'manual', traceId: ID.test(source.traceId || '') ? source.traceId : null, category: ID.test(source.category || '') ? source.category : null }
  const hash = contentHash(content)
  const id = `candidate_${crypto.randomUUID()}`
  const candidate = { version: 1, id, content: canonical(content), hash, sources, status: 'pending', createdAt: new Date().toISOString() }
  write(candidateFile(id), candidate)
  audit('candidate-created', { id, skillId: content.id, hash })
  return candidate
}
export function listBundledExamples() {
  if (!fs.existsSync(SOURCE_DIR)) return []
  return fs.readdirSync(SOURCE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && ID.test(e.name)).map((e) => {
    const meta = read(path.join(SOURCE_DIR, e.name, 'meta.json'))
    return meta ? { id: e.name, name: String(meta.name || e.name), status: 'pending', kind: 'bundled-example' } : null
  }).filter(Boolean)
}
export function proposeBundledExample(id, source = { kind: 'bundled-example' }) {
  assertId(id)
  const meta = read(path.join(SOURCE_DIR, id, 'meta.json'))
  if (!meta) throw new Error('样例不存在')
  const sop = fs.readFileSync(path.join(SOURCE_DIR, id, 'SKILL.md'), 'utf8').slice(0, 6000)
  return createSkillCandidate({ id, name: meta.name || id, description: meta.description || '', triggers: meta.triggers || [], sop, ...(meta.executionPlan ? { executionPlan: meta.executionPlan } : {}) }, source)
}
export function listSkillReviews() {
  const dir = storePath('candidates')
  const candidates = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^candidate_[a-zA-Z0-9_-]+\.json$/.test(n)).map((n) => read(path.join(dir, n))).filter(Boolean) : []
  const reg = registry()
  return { candidates: candidates.map((c) => ({ id: c.id, name: c.content.name, skillId: c.content.id, hash: c.hash, status: c.status, sources: c.sources, evaluation: read(storePath('evaluations', `${c.id}.json`)), createdAt: c.createdAt })), examples: listBundledExamples(), active: reg.active, history: reg.history }
}

// These fixtures live with the reviewer, independent of candidate files. All network
// actions are mocked here; a candidate cannot submit expected results or pass flags.
const MOCK_URL = 'https://example.com/reference'
const FIXTURES = Object.freeze([
  { id: 'public-document', input: `技术文档 ${MOCK_URL}`, expected: 'PUBLIC_FIXTURE_DOCUMENT', shouldMatch: true },
  { id: 'missing-address', input: '技术文档，请看一下', expectedError: true, shouldMatch: true },
  { id: 'private-address', input: '技术文档 http://127.0.0.1/private', expectedError: true, shouldMatch: true },
  { id: 'ordinary-chat', input: '今天中午吃什么', shouldMatch: false },
])
function triggersMatch(content, input) { return content.triggers.some((t) => compileSafeRegex(typeof t === 'string' ? t : t.pattern, typeof t === 'string' ? 'i' : t.flags || 'i').test(input.slice(0, 2048))) }
export async function evaluateCandidate(id) {
  const candidate = getSkillReview(id)
  validContent(candidate.content)
  if (contentHash(candidate.content) !== candidate.hash) throw new Error('候选内容哈希不匹配')
  const checks = []
  // SOP-only learning is intentionally confined to a human-reviewed short-reply
  // template. We cannot claim a static test measures LLM social quality.
  if (!candidate.content.executionPlan) {
    checks.push({ id: 'bounded-sop', passed: candidate.content.sop.length <= 1500 && !/https?:|\b(?:eval|exec|shell|fetch|require|import)\b|忽略.*(?:系统|规则)/i.test(candidate.content.sop) })
    checks.push({ id: 'specific-trigger', passed: triggersMatch(candidate.content, '不要回这么长') && !triggersMatch(candidate.content, '今天中午吃什么') })
  } else {
    const services = {
      async validateExternalUrl(url) { return url === MOCK_URL ? { ok: true, url } : { ok: false, error: 'fixture 地址白名单拒绝', fatal: true } },
      async fetchPageText(url) { return url === MOCK_URL ? { ok: true, title: 'Fixture', summary: 'PUBLIC_FIXTURE_DOCUMENT' } : { ok: false, error: '禁止真实网络', fatal: true } },
      async webSearch() { return { ok: false, error: '本评测集不批准搜索技能', fatal: true } },
    }
    for (const fixture of FIXTURES) {
      const matched = triggersMatch(candidate.content, fixture.input)
      let passed = matched === fixture.shouldMatch
      if (matched && fixture.shouldMatch) {
        const result = await executeSkillPipeline(candidate.content, { input: fixture.input }, { services, timeoutMs: 300 })
        passed = passed && (fixture.expectedError ? !result.ok : result.ok && String(result.context?.text || result.context?.result || '').includes(fixture.expected))
      }
      checks.push({ id: fixture.id, passed })
    }
    checks.push({ id: 'deny-prototype-action', passed: !validateSkillDefinition({ executionPlan: { pipeline: [{ action: 'constructor' }] } }).ok })
    checks.push({ id: 'deny-dangerous-regex', passed: !validateSkillDefinition({ executionPlan: { pipeline: [{ action: 'regex_extract', params: { pattern: '(a+)+$' } }] } }).ok })
  }
  const evaluation = { candidateId: id, hash: candidate.hash, evaluator: EVALUATOR_VERSION, fixtureHash: contentHash(FIXTURES), passed: checks.every((c) => c.passed), checks, at: new Date().toISOString(), network: 'mock-only' }
  write(storePath('evaluations', `${id}.json`), evaluation)
  audit('evaluated', { id, hash: candidate.hash, passed: evaluation.passed })
  return evaluation
}
export function activateCandidate(id, { expectedHash, reviewed = false } = {}) {
  const candidate = getSkillReview(id)
  validContent(candidate.content)
  if (!reviewed || expectedHash !== candidate.hash || contentHash(candidate.content) !== candidate.hash) throw new Error('须人工确认当前内容哈希')
  if (candidate.status === 'rejected') throw new Error('已拒绝的候选不能启用')
  const evaluation = candidate.evaluation
  if (!evaluation?.passed || evaluation.hash !== candidate.hash || evaluation.candidateId !== id || evaluation.evaluator !== EVALUATOR_VERSION || evaluation.fixtureHash !== contentHash(FIXTURES)) throw new Error('当前版本尚未通过独立离线评测')
  const approval = { content: candidate.content, hash: candidate.hash, approvedAt: new Date().toISOString(), evaluation, candidateId: id }
  write(storePath('versions', candidate.content.id, `${candidate.hash}.json`), approval)
  const reg = registry()
  const history = reg.history[candidate.content.id] || []
  if (!history.includes(candidate.hash)) history.push(candidate.hash)
  reg.history[candidate.content.id] = history
  reg.active[candidate.content.id] = candidate.hash
  write(storePath('registry.json'), reg)
  write(candidateFile(id), { ...candidate, status: 'active', evaluation: undefined, previous: undefined })
  audit('human-activated', { id, skillId: candidate.content.id, hash: candidate.hash })
  return { ok: true, hash: candidate.hash }
}
export function rejectCandidate(id) {
  const c = getSkillReview(id)
  if (registry().active[c.content.id] === c.hash) throw new Error('此版本正在使用，请先停用技能或回滚到其他版本')
  write(candidateFile(id), { ...c, status: 'rejected', evaluation: undefined, previous: undefined })
  audit('human-rejected', { id, hash: c.hash })
  return { ok: true }
}
export function loadApprovedVersion(skillId, hash) {
  if (!ID.test(skillId) || !HASH.test(hash || '')) return null
  const v = read(storePath('versions', skillId, `${hash}.json`))
  if (!v || v.hash !== hash || contentHash(v.content) !== hash || !v.approvedAt || !v.evaluation?.passed || v.evaluation.hash !== hash || v.evaluation.evaluator !== EVALUATOR_VERSION) return null
  try { validContent(v.content); return v } catch { return null }
}
export function getActiveSkillVersions() {
  return Object.entries(registry().active).map(([id, hash]) => loadApprovedVersion(id, hash)).filter(Boolean)
}
export function rollbackSkill(skillId, hash, { reviewed = false } = {}) {
  assertId(skillId)
  const reg = registry()
  if (!reviewed || !(reg.history[skillId] || []).includes(hash) || !loadApprovedVersion(skillId, hash)) throw new Error('只能人工回滚到已审批的有效版本')
  reg.active[skillId] = hash
  write(storePath('registry.json'), reg)
  audit('human-rollback', { skillId, hash })
  return { ok: true, hash }
}
export function deactivateSkill(skillId, { reviewed = false } = {}) {
  assertId(skillId)
  if (!reviewed) throw new Error('须人工确认停用技能')
  const reg = registry()
  const previousHash = reg.active[skillId] || null
  delete reg.active[skillId]
  write(storePath('registry.json'), reg)
  audit('human-deactivated', { skillId, previousHash })
  return { ok: true }
}
export function removeCandidatesFromTraces(traceIds) {
  if (!Array.isArray(traceIds) || traceIds.some((id) => typeof id !== 'string' || !/^trace_[a-zA-Z0-9_-]+$/.test(id))) throw new Error('无效的来源轨迹编号')
  const sortedIds = [...new Set(traceIds)].sort()
  if (!sortedIds.length) return { removed: 0 }
  const ids = new Set(sortedIds), candidateIds = new Set(), errors = []
  const intentFile = storePath('cleanup', `${contentHash(sortedIds)}.json`)
  // The intent survives deletion of either candidate or evaluation. A retry must
  // not need to read the already-deleted candidate to recover its source link.
  try {
    const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'))
    if (JSON.stringify(intent.traceIds) !== JSON.stringify(sortedIds) || !Array.isArray(intent.candidateIds)) throw new Error('候选清理意图格式无效')
    for (const id of intent.candidateIds) { assertId(id); candidateIds.add(id) }
  } catch (error) { if (error.code !== 'ENOENT') errors.push(error) }
  const dir = storePath('candidates')
  let files = []
  try { files = fs.readdirSync(dir) } catch (error) { if (error.code !== 'ENOENT') errors.push(error) }
  for (const name of files) {
    if (!/^candidate_[a-zA-Z0-9_-]+\.json$/.test(name)) continue
    try {
      const candidate = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (ids.has(candidate.sources?.traceId)) candidateIds.add(name.slice(0, -5))
    } catch (error) { if (error.code !== 'ENOENT') errors.push(error) }
  }
  // Persist before attempting any delete, including deletes which may succeed
  // while another file is locked. Failure to persist fails closed.
  try { write(intentFile, { version: 1, traceIds: sortedIds, candidateIds: [...candidateIds].sort() }) }
  catch (error) { throw new AggregateError([...errors, error], '无法持久化候选清理意图，请重试遗忘') }
  let removed = 0
  for (const id of candidateIds) {
    for (const file of [storePath('evaluations', `${id}.json`), candidateFile(id)]) {
      try { fs.rmSync(file, { force: true }); removed++ } catch (error) { errors.push(error) }
    }
  }
  if (!errors.length) {
    try { fs.rmSync(intentFile, { force: true }) } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, '技能候选清理尚未完成，请重试遗忘')
  return { removed }
}
