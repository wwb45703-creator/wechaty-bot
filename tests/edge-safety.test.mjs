import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-edge-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_OFFLINE = '1'
const config = { defaultPersona: 'High', personas: { High: { prompt: '热情角色', traits: { 信任倾向: 95 } }, Low: { prompt: '谨慎角色', traits: { 信任倾向: 5 } } }, ai: { model: 'fixture', baseUrl: 'http://127.0.0.1:11434' } }
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify(config))
const social = await import('../src/social/index.js')
const ai = await import('../src/ai.js')
const roles = await import('../src/persona-commands.js')
const tracer = await import('../src/skills/tracer.js')
const review = await import('../src/skills/review-store.js')
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const scope = { platform: 'wechat', accountId: 'edge-bot', conversationId: 'room:edge', personaId: 'High', subjectId: 'fixture-user' }

test('one interaction cannot snap a custom high/low role baseline to a shared hard limit', async () => {
  ai.initAi(config, { provider: { generate: async () => ({ text: '合成回复' }) } })
  for (const [role, input] of [['High', '谢谢你，解决了'], ['Low', '你说错了']]) {
    const s = { ...scope, personaId: role }
    const before = social.getSocialState(s).persona.traits['信任倾向']
    await social.commitInteraction({ scope: s, messageId: role, epoch: social.captureEpoch(s),
      userText: input, sendOutcome: { confirmedCount: 1 } })
    const after = social.getSocialState(s).persona.traits['信任倾向']
    assert.ok(Math.abs(after - before) <= 0.101)
    assert.ok(role === 'High' ? after >= before : after <= before)
  }
})

test('inherited object properties cannot be selected as configured personas', async () => {
  let reply
  await roles.handlePersonaCommand({ text: '变成constructor', ref: scope, reply: async text => { reply = text } })
  assert.match(reply, /没有叫/)
  assert.equal(roles.getActivePersonaName(scope), 'High')
})

test('diagnostic generation uses shared context without skills, traces, history or growth', async () => {
  const c = review.proposeBundledExample('jina-doc-reader')
  await review.evaluateCandidate(c.id)
  review.activateCandidate(c.id, { expectedHash: c.hash, reviewed: true })
  const before = social.getSocialState(scope).relationship.interactionCount
  ai.initAi(config, { provider: { generate: async () => ({ text: '仅本地诊断' }) } })
  const value = await ai.generateOnce('不要回这么长，官方文档 http://127.0.0.1/private',
    { scope, epoch: social.captureEpoch(scope), personaName: 'High', diagnostic: true })
  assert.equal(value, '仅本地诊断')
  assert.deepEqual(tracer.listInteractionTraces(), [])
  assert.equal(ai.conversations.size, 0)
  assert.equal(social.getSocialState(scope).relationship.interactionCount, before)
})

test('ambiguous alternation chains are rejected before synchronous evaluation', async () => {
  const { compileSafeRegex } = await import('../src/skills/dsl-executor.js')
  assert.throws(() => compileSafeRegex('(a|aa)'.repeat(30) + 'b'), /分组|结构/)
})
