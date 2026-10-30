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
const social = await import('../src/social/index.js')
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

test('a cached trace source cannot create or activate candidates after its epoch was forgotten', async () => {
  const s = scope('u-stale-source', 'c-stale-source')
  const trace = tracer.recordInteractionTrace({ scope: s, correction: '不要回这么长' })
  const candidate = tracer.generateCandidateFromTrace(trace.id)
  await review.evaluateCandidate(candidate.id)
  social.forgetSubject(s)
  // Simulate a cleanup failure retaining the old trace and review files.
  assert.equal(fs.existsSync(traceFile(trace.id)), true)
  assert.throws(() => review.createSkillCandidate(candidate.content, candidate.sources), /来源.*遗忘/)
  assert.throws(() => review.activateCandidate(candidate.id, { expectedHash: candidate.hash, reviewed: true }), /来源.*遗忘/)
  assert.throws(() => review.rejectCandidate(candidate.id), /来源.*遗忘/)
  await assert.rejects(review.evaluateCandidate(candidate.id), /来源.*遗忘/)
  tracer.purgeSubjectTraces(s)
  assert.throws(() => review.createSkillCandidate(candidate.content, candidate.sources), /来源.*遗忘/)
  assert.equal(review.listSkillReviews().candidates.some((c) => c.id === candidate.id), false)
})

test('forgetting while offline evaluation awaits cannot recreate an orphaned evaluation', async () => {
  const s = scope('u-evaluation-race', 'c-evaluation-race')
  const trace = tracer.recordInteractionTrace({ scope: s, errorMessage: 'HTTP 403', actionName: 'safe_fetch' })
  const candidate = tracer.generateCandidateFromTrace(trace.id)
  const running = review.evaluateCandidate(candidate.id)
  // This must run before the evaluator resumes, proving no lock crosses await.
  social.forgetSubject(s)
  tracer.purgeSubjectTraces(s)
  await assert.rejects(running, /候选不存在|来源.*遗忘/)
  assert.equal(fs.existsSync(candidateFile(candidate.id)), false)
  assert.equal(fs.existsSync(evaluationFile(candidate.id)), false)
})

test('an evaluation publishes only for the unchanged candidate and a current source', async () => {
  const edited = review.proposeBundledExample('jina-doc-reader')
  const runningEdit = review.evaluateCandidate(edited.id)
  const changed = { ...edited, content: { ...edited.content, name: '人工修改后的候选' } }
  changed.hash = review.contentHash(changed.content)
  fs.writeFileSync(candidateFile(edited.id), JSON.stringify(changed))
  await assert.rejects(runningEdit, /已变更/)
  assert.equal(fs.existsSync(evaluationFile(edited.id)), false)

  const s = scope('u-evaluation-epoch', 'c-evaluation-epoch')
  const trace = tracer.recordInteractionTrace({ scope: s, errorMessage: 'HTTP 403' })
  const candidate = tracer.generateCandidateFromTrace(trace.id)
  const runningForget = review.evaluateCandidate(candidate.id)
  social.forgetSubject(s)
  await assert.rejects(runningForget, /来源.*遗忘/)
  assert.equal(fs.existsSync(candidateFile(candidate.id)), true)
  assert.equal(fs.existsSync(evaluationFile(candidate.id)), false)
  tracer.purgeSubjectTraces(s)
})

test('approved abstract templates survive forgetting while private review links are removed retryably', async () => {
  const s = scope('u-approved-template', 'c-approved-template')
  const trace = tracer.recordInteractionTrace({ scope: s, correction: '不要回这么长' })
  const candidate = tracer.generateCandidateFromTrace(trace.id)
  await review.evaluateCandidate(candidate.id)
  review.activateCandidate(candidate.id, { expectedHash: candidate.hash, reviewed: true })
  const versionFile = path.join(root, 'state', 'skills', 'versions', candidate.content.id, `${candidate.hash}.json`)
  const approval = JSON.parse(fs.readFileSync(versionFile, 'utf8'))
  assert.equal(approval.candidateId, undefined)
  assert.equal(approval.evaluation.candidateId, undefined)
  // An older approval can still retain both links. Its cleanup must remain
  // retryable even when the candidate itself was successfully deleted.
  approval.candidateId = candidate.id
  approval.evaluation.candidateId = candidate.id
  fs.writeFileSync(versionFile, JSON.stringify(approval))
  const rename = fs.renameSync
  try {
    fs.renameSync = (from, to) => { if (to === versionFile) throw new Error('fixture locked approved template'); return rename(from, to) }
    assert.throws(() => tracer.purgeSubjectTraces(s), AggregateError)
  } finally { fs.renameSync = rename }
  assert.equal(fs.existsSync(candidateFile(candidate.id)), false)
  tracer.purgeSubjectTraces(s)
  const retained = review.loadApprovedVersion(candidate.content.id, candidate.hash)
  assert.ok(retained)
  assert.equal(retained.candidateId, undefined)
  assert.equal(retained.evaluation.candidateId, undefined)
  assert.equal(JSON.stringify(retained).includes(trace.id), false)
  assert.equal(JSON.stringify(retained).includes(candidate.id), false)
  assert.equal(review.getActiveSkillVersions().some((v) => v.hash === candidate.hash), true)
  assert.equal(fs.existsSync(evaluationFile(candidate.id)), false)
})

test('every synchronous skill mutation respects a live social writer lock', async () => {
  const candidate = review.proposeBundledExample('jina-doc-reader')
  await review.evaluateCandidate(candidate.id)
  review.activateCandidate(candidate.id, { expectedHash: candidate.hash, reviewed: true })
  const lock = path.join(root, 'state', 'social', 'writer.lock')
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  fs.writeFileSync(lock, String(process.pid))
  try {
    for (const operation of [
      () => review.createSkillCandidate(candidate.content),
      () => review.activateCandidate(candidate.id, { expectedHash: candidate.hash, reviewed: true }),
      () => review.rejectCandidate(candidate.id),
      () => review.deactivateSkill(candidate.content.id, { reviewed: true }),
      () => review.rollbackSkill(candidate.content.id, candidate.hash, { reviewed: true }),
      () => review.removeCandidatesFromTraces(['trace_fixture_locked']),
    ]) assert.throws(operation, /正在写入/)
  } finally { fs.rmSync(lock, { force: true }) }
})
