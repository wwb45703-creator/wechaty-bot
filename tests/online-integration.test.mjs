import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-online-integration-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
const conf = { defaultPersona: '鹅王', personas: { 鹅王: '你叫鹅王，温和友善' }, memory: { enabled: false },
  ai: { model: 'fixture', replyQuality: { enabled: true } }, reach: { enabled: true, search: { enabled: true, implicit: true } },
  astrbot: { enabled: true, baseUrl: 'http://127.0.0.1:6185', apiKey: `fixture-${randomUUID()}` } }
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify(conf))
const { initAi, chat, conversations, confirmConversationReply } = await import('../src/ai.js')
const { createOllamaProvider } = await import('../src/model-provider.js')
const { createResearchService } = await import('../src/reach/research.js')
const { captureEpoch } = await import('../src/social/index.js')
const { patchJsonValue } = await import('../src/config-patch.js')
const { validateReply } = await import('../src/reply-quality.js')
const { extractPublication } = await import('../src/url-utils.js')
const astrbot = await import('../src/reach/astrbot-client.js')
const { saveAstrBotConnection } = await import('../src/reach/astrbot-connection.js')
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Unexpected fixture network') }
test.after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

test('surgical JSON patches preserve handwritten role bytes, siblings and escaped nested strings', () => {
  const source = '{\n  "personaBase": "手写\\n文案 \\"引号\\"",\n  "ai": {"model":"old", "modelProfiles":{"x":{"options":{}}}},\n  "personas": {"鹅王":"保留 { } 标点"}\n}'
  const replaced = patchJsonValue(source, ['ai', 'model'], 'new')
  assert.equal(replaced, source.replace('"old"', '"new"'))
  const added = patchJsonValue(replaced, ['ai', 'replyQuality'], { enabled: true })
  assert.equal(JSON.parse(added).ai.replyQuality.enabled, true)
  assert.ok(added.includes('"personaBase": "手写\\n文案 \\"引号\\""'))
  assert.deepEqual(JSON.parse(added).personas, JSON.parse(source).personas)
  assert.equal(JSON.parse(patchJsonValue('{}', ['ai'], {})).ai.constructor, Object)
})

test('numeric evidence uses complete claims rather than substrings or unsupported dates and versions', () => {
  const research = { status: 'fresh', facts: '活动持续14天，版本v9.1，发布日期2026-11-02，奖励20原石' }
  assert.ok(validateReply('活动只持续4天', { research }).issues.includes('unsupported-number'))
  assert.ok(validateReply('版本为v9.9', { research }).issues.includes('unsupported-number'))
  assert.ok(validateReply('活动2026-11-03开始', { research }).issues.includes('unsupported-number'))
  assert.ok(validateReply('活动奖励200原石', { research }).issues.includes('unsupported-number'))
  assert.equal(validateReply('11月2日发布的9.1版本活动持续14天', { research }).ok, true)
})

test('publication metadata preserves source dates independently of attribute order and never invents a date', () => {
  assert.equal(extractPublication('<meta content="2026-11-02T09:00:00Z" property="article:published_time">'), '2026-11-02T09:00:00.000Z')
  assert.equal(extractPublication('<script type="application/ld+json">{"datePublished":"2026-10-30T09:00:00Z"}</script>'), '2026-10-30T09:00:00.000Z')
  assert.equal(extractPublication('<p>发布日期：2026年11月2日</p>')?.slice(0, 10), '2026-11-02')
  assert.equal(extractPublication('<h1>活动内容</h1><p>奖励20抽</p>'), null)
})

test('all eight selected models receive shared research evidence in their actual generation packet', async () => {
  const models = ['qwen2.5:7b-instruct', 'huihui_ai/qwen2.5-vl-abliterated:latest',
    'hf.co/Ttimofeyka/MistralRP-Noromaid-NSFW-Mistral-7B-GGUF:Q4_0', 'qwen2.5vl:7b',
    'huihui_ai/qwen3-abliterated:8b', 'gpt-oss:20b', 'llama3.1:8B', 'qwen2.5:0.5b']
  let searches = 0
  const at = Date.parse('2026-11-02T10:00:00Z')
  const service = createResearchService({ now: () => at, search: async () => {
    searches++; return { results: [{ title: '原神国服活动公告', url: 'https://www.hoyoverse.com/fixture', snippet: '原神国服活动将在11月3日开启，奖励20抽' }] }
  }, reader: async () => ({ ok: true, text: '原神国服活动将在11月3日开启，奖励20抽', publishedAt: '2026-11-02T00:00:00Z' }) })
  for (const model of models) {
    const packets = [], config = { ...conf, ai: { ...conf.ai, model } }
    const provider = createOllamaProvider(config, { fetchImpl: async (_url, request) => {
      packets.push(JSON.parse(request.body)); return Response.json({ message: { content: '公告写明11月3日开启，奖励20抽' } })
    } })
    initAi(config, { provider })
    let evidence
    const answer = await chat({ key: `research-once:${model}`, userText: '原神国服这次活动奖励如何', diagnostic: true, research: true,
      researchDependencies: { service, planner: async () => ({ needed: true, kind: 'game', game: '原神', query: '原神 国服 活动' }) }, onResearch: item => { evidence = item } })
    assert.equal(answer, '公告写明11月3日开启，奖励20抽')
    assert.equal(packets.length, 1); assert.equal(packets[0].model, model)
    assert.match(JSON.stringify(packets[0].messages), /国服活动将在11月3日开启，奖励20抽/)
    assert.match(JSON.stringify(packets[0].messages), /鹅王/)
    assert.equal(evidence.status, searches === 1 && model === models[0] ? 'fresh' : 'cached')
  }
  assert.equal(searches, 1, 'public facts are reused across model switches')
})

test('only confirmed replies enter recent history; repeated rewritten drafts are suppressed', async () => {
  let calls = 0
  initAi({ ...conf, reach: { enabled: false } }, { provider: { generate: async () => { calls++; return { text: '先把最容易失误的那一步稳住' } } } })
  const scope = { platform: 'wechat', accountId: 'fixture-bot', conversationId: 'room:fixture', personaId: '鹅王', subjectId: 'fixture-user' }
  const key = 'confirmed-replies', args = { key, scope, epoch: captureEpoch(scope), userText: '又没打好' }
  const first = await chat(args)
  assert.equal(await chat(args), first, 'an unsent draft cannot poison recent sent history')
  assert.ok(conversations.get(key).every(row => row.role !== 'assistant'))
  confirmConversationReply({ key, scope, reply: first })
  assert.equal(await chat(args), null)
  assert.equal(calls, 4, 'one original attempt and one rewrite after the two unsent drafts')
  assert.equal(conversations.get(key).filter(row => row.role === 'assistant').length, 1)
})

test('client status separates plugin success from kb denial, latches polling and recovers on changed key', async () => {
  let kbRequests = 0, mode = 'forbidden'
  globalThis.fetch = async url => {
    if (String(url).endsWith('/plugins')) return Response.json({ status: 'ok', data: [{ name: 'fixture-plugin' }] })
    assert.ok(String(url).endsWith('/knowledge-bases')); kbRequests++
    if (mode === 'forbidden') return Response.json({ message: 'Insufficient API key scope' }, { status: 403 })
    return Response.json({ status: 'ok', data: { items: [{ kb_id: 'fixture-kb', kb_name: 'fixture library' }] } })
  }
  for (let i = 0; i < 12; i++) {
    const status = await astrbot.getAstrBotStatus()
    assert.equal(status.alive, true); assert.equal(status.pluginCount, 1); assert.equal(status.kbCount, null)
    assert.equal(status.capabilities.knowledge.code, 'PERMISSION_DENIED')
    assert.equal(status.capabilities.knowledge.requiredScope, 'kb')
  }
  assert.equal(kbRequests, 1)
  await astrbot.getAstrBotStatus({ force: true }); assert.equal(kbRequests, 2)
  mode = 'ready'
  saveAstrBotConnection({ apiKey: `fixture-${randomUUID()}` })
  const recovered = await astrbot.getAstrBotStatus()
  assert.equal(recovered.kbCount, 1); assert.equal(recovered.capabilities.knowledge.status, 'ready')
  assert.equal(kbRequests, 3)
})
