import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-skill-forget-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ ai: {}, astrbot: { enabled: false } }))
const tracer = await import('../src/skills/tracer.js')
const review = await import('../src/skills/review-store.js')
const { compileSafeRegex } = await import('../src/skills/dsl-executor.js')
after(() => fs.rmSync(root, { recursive: true, force: true }))
const scope = (subjectId, conversationId = 'private:a') => ({ platform: 'wechat', accountId: 'bot', conversationId, personaId: 'role', subjectId })
const traceFile = (id) => path.join(root, 'state', 'proposals', `${id}.json`)
const candidateFile = (id) => path.join(root, 'state', 'skills', 'candidates', `${id}.json`)
const evaluationFile = (id) => path.join(root, 'state', 'skills', 'evaluations', `${id}.json`)

test('one locked trace is reported while other matches are attempted and a later retry completes', () => {
  const first = tracer.recordInteractionTrace({ scope: scope('u-a', 'c-a'), correction: '不要回这么长' })
  const second = tracer.recordInteractionTrace({ scope: scope('u-a', 'c-b'), correction: '不要回这么长' })
  const other = tracer.recordInteractionTrace({ scope: scope('u-other'), correction: '不要回这么长' })
  const unlink = fs.unlinkSync
  try {
    fs.unlinkSync = (file) => { if (file === traceFile(first.id)) throw Object.assign(new Error('fixture locked trace'), { code: 'EPERM' }); return unlink(file) }
    assert.throws(() => tracer.purgeSubjectTraces(scope('u-a'), { allConversations: true }), AggregateError)
  } finally { fs.unlinkSync = unlink }
  assert.equal(fs.existsSync(traceFile(first.id)), true)
  assert.equal(fs.existsSync(traceFile(second.id)), false)
  assert.equal(fs.existsSync(traceFile(other.id)), true)
  assert.equal(tracer.purgeSubjectTraces(scope('u-a'), { allConversations: true }).removed, 1)
})
test('evaluation failure remains retryable even after its candidate file was deleted', async () => {
  const trace = tracer.recordInteractionTrace({ scope: scope('u-eval'), correction: '不要回这么长' })
  const candidate = tracer.generateCandidateFromTrace(trace.id)
  await review.evaluateCandidate(candidate.id)
  const remove = fs.rmSync
  try {
    fs.rmSync = (file, options) => { if (file === evaluationFile(candidate.id)) throw Object.assign(new Error('fixture locked evaluation'), { code: 'EPERM' }); return remove(file, options) }
    assert.throws(() => tracer.purgeSubjectTraces(scope('u-eval')), AggregateError)
  } finally { fs.rmSync = remove }
  assert.equal(fs.existsSync(candidateFile(candidate.id)), false)
  assert.equal(fs.existsSync(evaluationFile(candidate.id)), true)
  assert.equal(fs.existsSync(traceFile(trace.id)), true)
  tracer.purgeSubjectTraces(scope('u-eval'))
  assert.equal(fs.existsSync(evaluationFile(candidate.id)), false)
  assert.equal(fs.existsSync(traceFile(trace.id)), false)
})
test('candidate deletion failure does not prevent other candidates from being removed', () => {
  const trace = tracer.recordInteractionTrace({ scope: scope('u-candidate'), correction: '不要回这么长' })
  const a = tracer.generateCandidateFromTrace(trace.id), b = tracer.generateCandidateFromTrace(trace.id)
  const remove = fs.rmSync
  try {
    fs.rmSync = (file, options) => { if (file === candidateFile(a.id)) throw new Error('fixture locked candidate'); return remove(file, options) }
    assert.throws(() => tracer.purgeSubjectTraces(scope('u-candidate')), AggregateError)
  } finally { fs.rmSync = remove }
  assert.equal(fs.existsSync(candidateFile(a.id)), true)
  assert.equal(fs.existsSync(candidateFile(b.id)), false)
  tracer.purgeSubjectTraces(scope('u-candidate'))
  assert.equal(fs.existsSync(candidateFile(a.id)), false)
})
test('deletion traverses all traces rather than the 200 row display limit', () => {
  const s = scope('u-many')
  const first = tracer.recordInteractionTrace({ scope: s, correction: '不要回这么长' })
  for (let i = 0; i < 205; i++) {
    const id = `trace_fixture_${i}`
    fs.writeFileSync(traceFile(id), JSON.stringify({ ...first, id }))
  }
  assert.ok(tracer.listInteractionTraces().length <= 200)
  assert.equal(tracer.purgeSubjectTraces(s).removed, 206)
})
test('long optional quantifier chains are rejected before synchronous regex execution', () => {
  assert.throws(() => compileSafeRegex('a?'.repeat(45) + 'a'.repeat(45) + 'b'), /量词/)
  assert.throws(() => compileSafeRegex('a?b?c?'), /量词/)
  assert.equal(compileSafeRegex('(https?://[^\\s<>]+)').test('https://example.com/docs'), true)
  assert.equal(compileSafeRegex('(官方文档|api\\s*手册|开发指南)').test('api 手册'), true)
})
