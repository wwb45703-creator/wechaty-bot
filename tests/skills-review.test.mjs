import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, after } from 'node:test'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-skill-review-'))
process.env.BOT_DATA_ROOT = sandbox
process.env.BOT_CONFIG_FILE = path.join(sandbox, 'config.json')
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ ai: {}, astrbot: { enabled: false } }))
const dsl = await import('../src/skills/dsl-executor.js')
const review = await import('../src/skills/review-store.js')
const router = await import('../src/skills/skill-router.js')
const tracer = await import('../src/skills/tracer.js')
after(() => fs.rmSync(sandbox, { recursive: true, force: true }))
const plan = (pipeline) => ({ executionPlan: { pipeline } })
const scope = (subjectId, conversationId = 'private:a', personaId = 'goose') => ({ platform: 'wechat', accountId: 'test-bot', conversationId, personaId, subjectId })

test('DSL rejects inherited actions, unknown schema, expensive regex and too many steps', async () => {
  for (const action of ['constructor', '__proto__', 'toString', 'eval', 'shell_exec']) assert.equal((await dsl.executeSkillPipeline(plan([{ action, ignoreError: true }]))).ok, false)
  assert.equal(dsl.validateSkillDefinition(plan(Array(9).fill({ action: 'template_render', params: { template: 'x' } }))).ok, false)
  for (const pattern of ['(a+)+$', '(a|aa)+$', 'a*a*a*', '(?=x)', '\\1', 'x{2,}']) assert.throws(() => dsl.compileSafeRegex(pattern))
  assert.equal(dsl.validateSkillDefinition(plan([{ action: 'template_render', params: { template: 'x', code: 'run()' } }])).ok, false)
  assert.equal(dsl.renderTemplate('{{constructor}}/{{$1}}/{{safe}}', { $1: 'captured', safe: 'value' }), '/captured/value')
})
test('capture interpolation, real response shape and fatal SSRF ignoreError boundary', async () => {
  let fetched
  const services = {
    async validateExternalUrl(url) { return url.startsWith('https://example.com/') ? { ok: true, url } : { ok: false, error: 'private', fatal: true } },
    async fetchPageText(url) { fetched = url; return { ok: true, title: 'Title', summary: 'Public summary' } },
  }
  const result = await dsl.executeSkillPipeline(plan([
    { action: 'regex_extract', params: { pattern: '(https?://[^\\s<>]+)' } },
    { action: 'safe_fetch', params: { url: '{{$1}}' } },
    { action: 'template_render', params: { template: '{{title}}: {{text}}' } },
  ]), { input: '看文档 https://example.com/docs' }, { services })
  assert.equal(result.ok, true); assert.equal(fetched, 'https://example.com/docs'); assert.equal(result.context.result, 'Title: Public summary')
  const blocked = await dsl.executeSkillPipeline(plan([{ action: 'safe_fetch', params: { url: 'http://127.0.0.1/secret' }, ignoreError: true }, { action: 'template_render', params: { template: 'fake-success' } }]), {}, { services })
  assert.equal(blocked.ok, false); assert.match(blocked.error, /SSRF/)
  const failed = await dsl.executeSkillPipeline(plan([{ action: 'safe_fetch', params: { url: 'https://example.com/docs' } }]), {}, { services: { ...services, async fetchPageText() { return { ok: false, error: 'HTTP 403' } } } })
  assert.equal(failed.ok, false); assert.match(failed.error, /403/)
})
test('DSL deadline and cancellation stop even a noncooperative mocked service', async () => {
  const services = { async validateExternalUrl() { return new Promise(() => {}) } }
  const r = await dsl.executeSkillPipeline(plan([{ action: 'safe_fetch', params: { url: 'https://example.com/' } }]), {}, { timeoutMs: 15, services })
  assert.equal(r.ok, false); assert.match(r.error, /超时/)
  const abort = new AbortController(); abort.abort()
  assert.equal((await dsl.executeSkillPipeline(plan([{ action: 'template_render', params: { template: 'x' } }]), {}, { signal: abort.signal })).ok, false)
})
test('bundled sample and self-reported approval never route without evaluator plus explicit approval', async () => {
  assert.equal(router.matchSkill('官方文档 https://example.com/reference'), null)
  const c = review.proposeBundledExample('jina-doc-reader')
  assert.equal(router.matchSkill('官方文档 https://example.com/reference'), null)
  assert.throws(() => review.activateCandidate(c.id, { expectedHash: c.hash, reviewed: true }), /评测/)
  const e = await review.evaluateCandidate(c.id)
  assert.equal(e.passed, true); assert.equal(e.network, 'mock-only'); assert.equal(e.hash, c.hash)
  assert.throws(() => review.activateCandidate(c.id, { expectedHash: c.hash }), /人工/)
  review.activateCandidate(c.id, { expectedHash: c.hash, reviewed: true })
  assert.equal(router.matchSkill('官方文档 https://example.com/reference').id, 'jina-doc-reader')
  assert.match(router.getSkillSOP('jina-doc-reader'), /已审核/)
})
test('independent fixtures catch fake successful DSL and bind evaluation to exact content', async () => {
  const original = review.proposeBundledExample('jina-doc-reader')
  const fake = review.createSkillCandidate({ ...original.content, executionPlan: { pipeline: [{ action: 'template_render', params: { template: 'PUBLIC_FIXTURE_DOCUMENT' } }] }, passed: true, approved: true, evaluation: { passed: true } })
  const failed = await review.evaluateCandidate(fake.id)
  assert.equal(failed.passed, false)
  assert.throws(() => review.activateCandidate(fake.id, { expectedHash: fake.hash, reviewed: true }), /评测/)
  const valid = review.proposeBundledExample('jina-doc-reader'); await review.evaluateCandidate(valid.id)
  const file = path.join(sandbox, 'state', 'skills', 'candidates', `${valid.id}.json`)
  const altered = JSON.parse(fs.readFileSync(file)); altered.content.sop += '\nchanged'; fs.writeFileSync(file, JSON.stringify(altered))
  assert.throws(() => review.activateCandidate(valid.id, { expectedHash: valid.hash, reviewed: true }), /哈希/)
})
test('approved history supports explicit rollback and content tampering disables routing', async () => {
  const first = review.getActiveSkillVersions()[0]
  const second = review.createSkillCandidate({ ...first.content, name: '文档技能第二版' })
  await review.evaluateCandidate(second.id); review.activateCandidate(second.id, { expectedHash: second.hash, reviewed: true })
  assert.equal(router.matchSkill('官方文档').hash, second.hash)
  assert.throws(() => review.rollbackSkill('jina-doc-reader', first.hash), /人工/)
  review.rollbackSkill('jina-doc-reader', first.hash, { reviewed: true })
  assert.equal(router.matchSkill('官方文档').hash, first.hash)
  const versionFile = path.join(sandbox, 'state', 'skills', 'versions', 'jina-doc-reader', `${first.hash}.json`)
  const mutated = JSON.parse(fs.readFileSync(versionFile)); mutated.content.sop = 'tampered'; fs.writeFileSync(versionFile, JSON.stringify(mutated))
  assert.equal(router.matchSkill('官方文档'), null)
})
test('traces retain no raw content and forgetting purges subject sources across roles/conversations', async () => {
  const privateText = '不要回这么长，张私密 密钥=secret https://private.example/token?secret=abc'
  const a = tracer.recordInteractionTrace({ scope: scope('u-a'), userText: privateText, correction: privateText, errorMessage: privateText })
  const b = tracer.recordInteractionTrace({ scope: scope('u-a', 'room:one', 'fish'), correction: '不要分段' })
  const other = tracer.recordInteractionTrace({ scope: scope('u-b'), correction: '不要回这么长' })
  assert.ok(a && b && other)
  const saved = fs.readFileSync(path.join(sandbox, 'state', 'proposals', `${a.id}.json`), 'utf8')
  for (const secret of ['张私密', 'secret', 'https://', 'u-a', privateText]) assert.equal(saved.includes(secret), false)
  const candidate = tracer.generateCandidateFromTrace(a.id)
  assert.equal((await review.evaluateCandidate(candidate.id)).passed, true)
  assert.equal(tracer.purgeSubjectTraces(scope('u-a')).removed, 1)
  assert.throws(() => review.getSkillReview(candidate.id), /不存在/)
  assert.equal(tracer.purgeSubjectTraces(scope('u-a'), { allConversations: true }).removed, 1)
  assert.deepEqual(tracer.listInteractionTraces().map((t) => t.id), [other.id])
  assert.equal(tracer.recordInteractionTrace({ sessionId: 'unknown', userText: privateText }), null)
})
test('tool failure trace yields a source-bound safe template that is tested before activation', async () => {
  const trace = tracer.recordInteractionTrace({ scope: scope('tool-user'), actionName: 'safe_fetch', errorMessage: 'HTTP 403 for https://private.example/?token=hidden' })
  assert.equal(trace.category, 'fetch-failed')
  const candidate = tracer.generateCandidateFromTrace(trace.id)
  assert.equal(candidate.sources.traceId, trace.id)
  assert.equal(candidate.sources.kind, 'trace-template')
  assert.equal(JSON.stringify(candidate).includes('private.example'), false)
  assert.throws(() => review.activateCandidate(candidate.id, { expectedHash: candidate.hash, reviewed: true }), /评测/)
  assert.equal((await review.evaluateCandidate(candidate.id)).passed, true)
  review.activateCandidate(candidate.id, { expectedHash: candidate.hash, reviewed: true })
  assert.equal(router.matchSkill('技术文档 https://example.com/reference').hash, candidate.hash)
})

test('first approved version can be explicitly disabled and restored without pretending rejection stops it', async () => {
  const candidate = review.createSkillCandidate({ id: 'concise-offswitch', name: '停用测试',
    description: '固定审核模板', triggers: ['不要回这么长'], sop: '请用一两句概括当前问题，保持事实完整。' })
  assert.equal((await review.evaluateCandidate(candidate.id)).passed, true)
  review.activateCandidate(candidate.id, { expectedHash: candidate.hash, reviewed: true })
  assert.throws(() => review.rejectCandidate(candidate.id), /停用|回滚/)
  assert.throws(() => review.deactivateSkill('concise-offswitch'), /人工/)
  review.deactivateSkill('concise-offswitch', { reviewed: true })
  assert.equal(router.matchSkill('不要回这么长'), null)
  review.rollbackSkill('concise-offswitch', candidate.hash, { reviewed: true })
  assert.equal(router.matchSkill('不要回这么长').hash, candidate.hash)
})
