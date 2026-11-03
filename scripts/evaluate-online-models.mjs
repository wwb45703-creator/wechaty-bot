/** Explicit isolated live Ollama benchmark. Never starts/stops services or sends WeChat. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
if (!process.argv.includes('--live')) throw new Error('Pass --live after pausing the bot with its normal control script')
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(project, '.test-artifacts', 'online-models')
fs.mkdirSync(output, { recursive: true })
const source = JSON.parse(fs.readFileSync(path.join(project, 'config.json'), 'utf8'))
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-model-evaluation-'))
process.env.BOT_DATA_ROOT = temp
process.env.BOT_CONFIG_FILE = path.join(temp, 'config.json')
process.env.BOT_TEST_MODE = '1'
const config = { ai: { ...source.ai, keepAlive: '2m', timeoutSeconds: 120 }, defaultPersona: source.defaultPersona,
  personas: source.personas, personaBase: source.personaBase, memory: { enabled: false },
  reach: { enabled: true, search: { enabled: true, implicit: true }, jina: { enabled: false } } }
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify(config))
const { createOllamaProvider } = await import('../src/model-provider.js')
const { initAi, chat, confirmConversationReply, resetConversation } = await import('../src/ai.js')
const { createResearchService } = await import('../src/reach/research.js')
const { captureEpoch } = await import('../src/social/index.js')
const { validateReply } = await import('../src/reply-quality.js')
const installed = (await (await fetch('http://127.0.0.1:11434/api/tags')).json()).models
const selected = process.env.BOT_EVAL_MODELS?.split('|')
const models = installed.filter(model => !/embed/i.test(model.name) && (!selected || selected.includes(model.name))).map(model => model.name)
const report = { at: new Date().toISOString(), limitations: 'Synthetic public-source fixtures plus real local inference; heuristic relevance, not human ratings. No WeChat, private memories, cloud inference or model downloads.', models: [], publicNetwork: [] }
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
const today = new Date().toISOString()
const fixtureService = createResearchService({ search: async query => ({ results: query.includes('蓝莓') ? [
  { title: '蓝莓启动的合成评测释义', url: 'https://meme-fixture-one.example/fixture', snippet: '蓝莓启动是合成测试中的说法，形容说好只看一眼视频，结果越刷越停不下来，不代表真实流行梗。' },
  { title: '蓝莓启动的合成语境', url: 'https://meme-fixture-two.example/fixture', snippet: '在这组评测语境里，蓝莓启动表示本想只看一眼视频，结果越刷越停不下来。' },
] : [{ title: '原神国服演练活动合成公告', url: 'https://www.mihoyo.com/fixture-evaluation', publishedAt: today,
  snippet: '这是合成评测公告，原神国服演练活动于11月3日开启。奖励尚未公布，不能猜测奖励数额。' }] }), reader: async () => null })
const cases = [
  { name: 'identity', text: '你是谁，性格怎么样', relevant: reply => /鹅王|AI助手|群.*助手/i.test(reply) },
  { name: 'casual', text: '开局总是乱，连队友都看不下去了', relevant: reply => /开局|练|稳|一步|节奏|熟|慢|急|失误/.test(reply) },
  { name: 'meme', text: '大家一直刷蓝莓启动，这是什么梗', research: true, relevant: reply => /看|刷|视频|停不下来|一眼/.test(reply) },
  { name: 'current-event', text: '原神国服演练活动几号开始，奖励多少', research: true, relevant: reply => /11月3|十一月三/.test(reply) && /未|没|暂|不确定|公告/.test(reply) },
  { name: 'followup', text: '这次训练还是没打顺，先慢慢练', relevant: reply => /练|稳|慢|急|节奏|熟|失误|一步|顺/.test(reply) },
]
try {
  for (const model of models) {
    const activeConfig = { ...config, ai: { ...config.ai, model } }, base = createOllamaProvider(activeConfig)
    const record = { model, cases: [] }; report.models.push(record)
    const calls = []
    initAi(activeConfig, { provider: { async generate(args) {
      const started = Date.now(), call = { type: args.format === 'json' ? 'intent' : 'reply', elapsedMs: 0 }
      calls.push(call)
      try { const result = await base.generate(args); Object.assign(call, { text: result.text, usage: result.usage }); return result }
      catch (error) { call.error = error.message; throw error }
      finally { call.elapsedMs = Date.now() - started }
    } } })
    const scope = { platform: 'wechat', accountId: 'evaluation-bot', conversationId: 'room:evaluation', personaId: config.defaultPersona, subjectId: 'evaluation-subject' }
    const key = `model-evaluation:${model}`, contextRows = []
    for (const item of cases) {
      const started = Date.now(), startCall = calls.length
      let evidence
      const reply = await chat({ key, scope, epoch: captureEpoch(scope), personaName: config.defaultPersona,
        userText: item.text, diagnostic: true, research: item.research === true, contextRows,
        researchDependencies: { service: fixtureService }, onResearch: value => { evidence = value } })
      if (reply) confirmConversationReply({ key, scope, reply })
      contextRows.push({ text: item.text, name: '合成评测用户' })
      const row = { name: item.name, input: item.text, reply, elapsedMs: Date.now() - started,
        delivered: Boolean(reply), stylePassed: Boolean(reply) && validateReply(reply, { userText: item.text }).ok,
        relevanceHeuristic: Boolean(reply) && item.relevant(reply), researchStatus: evidence?.status, researchReason: evidence?.reason,
        calls: calls.slice(startCall) }
      record.cases.push(row); save()
      console.log(JSON.stringify({ model, case: item.name, reply, elapsedMs: row.elapsedMs, style: row.stylePassed, relevant: row.relevanceHeuristic, research: row.researchStatus }))
    }
    resetConversation(key)
    await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }) })
  }
  const network = createResearchService()
  for (const text of ['哈基米曼波是什么梗', '原神国服最新活动公告']) {
    const started = Date.now(), result = await network.prepare({ text })
    report.publicNetwork.push({ input: text, elapsedMs: Date.now() - started, ...result })
    console.log(JSON.stringify({ network: text, status: result.status, reason: result.reason, sources: result.sources.length }))
    save()
  }
  network.clear()
} finally {
  fixtureService.clear(); save()
  if (path.dirname(fs.realpathSync(temp)) !== fs.realpathSync(os.tmpdir()) || !path.basename(temp).startsWith('wechat-model-evaluation-')) throw new Error('Unexpected evaluation sandbox')
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}
