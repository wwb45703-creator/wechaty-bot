import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-model-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ defaultPersona: 'A', personas: { A: '角色甲', B: '角色乙' }, ai: { model: 'fixture', baseUrl: 'http://127.0.0.1:11434' } }))
const { createOllamaProvider } = await import('../src/model-provider.js')
const { initAi, chat, describeImage, extractFacts, conversations, confirmConversationReply, resetConversationScope } = await import('../src/ai.js')
const social = await import('../src/social/index.js')
const config = JSON.parse(fs.readFileSync(process.env.BOT_CONFIG_FILE, 'utf8'))
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const scope = { accountId: 'model-bot', conversationId: 'room:r1', personaId: 'A', subjectId: 'alice' }

test('local provider refuses cloud endpoints and reports structured usage', async () => {
  assert.throws(() => createOllamaProvider({ baseUrl: 'https://api.deepseek.com', model: 'x' }), /本地模式/)
  assert.throws(() => createOllamaProvider({ provider: 'deepseek', model: 'x' }), /仅启用/)
  let packet
  const provider = createOllamaProvider(config, { fetchImpl: async (_url, init) => {
    packet = JSON.parse(init.body)
    return new Response(JSON.stringify({ message: { content: '回应' }, prompt_eval_count: 123, eval_count: 12 }))
  } })
  const result = await provider.generate({ messages: [{ role: 'user', content: '你好' }] })
  assert.equal(result.provider, 'ollama'); assert.deepEqual(result.usage, { inputTokens: 123, outputTokens: 12 })
  assert.equal(packet.think, false)
})

test('provider deadline covers stalled model responses and JSON bodies', async () => {
  const pending = () => new Promise(() => {})
  for (const fetchImpl of [pending, async () => ({ ok: true, json: pending })]) {
    const started = Date.now()
    const provider = createOllamaProvider(config, { fetchImpl })
    await assert.rejects(provider.generate({ messages: [{ role: 'user', content: '你好' }], timeoutMs: 30 }), /取消|超时/)
    assert.ok(Date.now() - started < 1000)
  }
})

test('text, one-shot and image generation use selected role; generated text is not sent history', async () => {
  const systems = []
  initAi(config, { provider: { generate: async ({ messages }) => { systems.push(messages[0].content); return { text: '一条自然回复' } } } })
  const key = JSON.stringify(['wechat', scope.accountId, scope.conversationId, 'A'])
  const epoch = social.captureEpoch(scope)
  assert.equal(await chat({ key, scope, epoch, personaName: 'A', userText: '你好' }), '一条自然回复')
  assert.deepEqual(conversations.get(key).map(x => x.role), ['user'])
  confirmConversationReply({ key, scope, reply: '一条自然回复' })
  assert.equal(conversations.get(key).at(-1).role, 'assistant')
  await chat({ key: 'topic-once:one', scope: { ...scope, personaId: 'B' }, epoch, personaName: 'B', userText: '发起话题' })
  const image = path.join(root, 'fixture.png'); fs.writeFileSync(image, Buffer.from('fixture'))
  await describeImage({ imagePath: image, prompt: '点评', personaName: 'B', scope: { ...scope, personaId: 'B' }, epoch })
  assert.match(systems[0], /角色甲/); assert.match(systems[1], /角色乙/); assert.match(systems[2], /角色乙/)
  assert.equal(social.getSocialState(scope).relationship.interactionCount, 0)
})

test('forget invalidates pending model results and clears every role history in conversation', async () => {
  let release, ready
  const started = new Promise(resolve => { ready = resolve })
  initAi(config, { provider: { generate: async () => { ready(); return { text: await new Promise(resolve => { release = resolve }) } } } })
  const key = 'pending-room-history'
  const result = chat({ key, scope, epoch: social.captureEpoch(scope), userText: '需要遗忘的原话' })
  await started
  await social.forgetSubject(scope)
  release('不应发送的旧回复')
  assert.equal(await result, null)
  assert.equal(conversations.has(key), false)
  resetConversationScope(scope)
})

test('extraction receives user statements only and preserves correction slots', async () => {
  let input
  initAi(config, { provider: { generate: async ({ messages }) => {
    input = messages.at(-1).content
    return { text: '{"facts":[{"text":"用户职业是教师","key":"occupation","confidence":0.9}]}' }
  } } })
  const facts = await extractFacts({ userText: '我现在是教师', assistantReply: '助手编造的秘密' })
  assert.match(input, /我现在是教师/); assert.doesNotMatch(input, /助手编造的秘密/)
  assert.equal(facts[0].key, 'occupation')
})

test('memory disabled excludes existing facts without losing the selected character', async () => {
  const s = { ...scope, subjectId: 'disabled-memory' }
  social.recordObservation({ scope: s, sourceId: 'one', facts: ['用户有一只名叫保密猫的猫'], epoch: social.captureEpoch(s) })
  let system
  initAi({ ...config, memory: { enabled: false } }, { provider: { generate: async ({ messages }) => { system = messages[0].content; return { text: '好的' } } } })
  await chat({ key: 'memory-off-once:1', scope: s, personaName: 'A', epoch: social.captureEpoch(s), userText: '你好' })
  assert.doesNotMatch(system, /保密猫/); assert.match(system, /角色甲/)
})

test('chat forget also purges derived correction traces and draft candidates', async () => {
  const tracer = await import('../src/skills/tracer.js')
  const review = await import('../src/skills/review-store.js')
  const scoped = { ...scope, subjectId: 'correction-owner', personaId: 'A' }
  initAi(config, { provider: { generate: async () => ({ text: '好的，简短说' }) } })
  await chat({ key: 'correction-history', scope: scoped, epoch: social.captureEpoch(scoped),
    userText: '不要回这么长' })
  const trace = tracer.listInteractionTraces().find(t => t.category === 'reply-length')
  assert.ok(trace)
  const candidate = tracer.generateCandidateFromTrace(trace.id)
  await social.forgetSubject(scoped)
  assert.equal(tracer.listInteractionTraces().some(t => t.id === trace.id), false)
  assert.throws(() => review.getSkillReview(candidate.id), /不存在/)
})

test('console-style forgetting in another process invalidates cached group history before a new speaker reads it', async () => {
  const alice = { ...scope, conversationId: 'room:cross-process', subjectId: 'alice' }
  const bob = { ...alice, subjectId: 'bob' }
  const key = JSON.stringify(['wechat', alice.accountId, alice.conversationId, 'A'])
  let lastMessages
  initAi(config, { provider: { generate: async ({ messages }) => {
    lastMessages = structuredClone(messages)
    return { text: messages.at(-1).content === '继续聊' ? '我们聊点新的' : '明白这次交流了' }
  } } })
  await chat({ key, scope: alice, epoch: social.captureEpoch(alice), userText: '仅限本次测试的私密猫名' })
  confirmConversationReply({ key, scope: alice, reply: '明白这次交流了' })
  await chat({ key, scope: bob, epoch: social.captureEpoch(bob), userText: '先接一句话' })
  assert.match(JSON.stringify(lastMessages), /私密猫名/)
  const url = new URL('../src/social/index.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const social = await import(${JSON.stringify(url)}); await social.forgetSubject(${JSON.stringify(alice)});`],
  { env: { ...process.env }, encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(child.status, 0, child.stderr)
  await chat({ key, scope: bob, epoch: social.captureEpoch(bob), userText: '继续聊' })
  assert.doesNotMatch(JSON.stringify(lastMessages), /私密猫名|先接一句话/)
  assert.deepEqual(lastMessages.slice(1).map(x => x.content), ['继续聊'])
})
