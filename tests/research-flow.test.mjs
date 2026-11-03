/** Deterministic research flow; all search, document and planner calls are injected fixtures. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-research-flow-'))
const envKeys = ['BOT_DATA_ROOT', 'BOT_CONFIG_FILE', 'BOT_TEST_MODE', 'BOT_OFFLINE']
const inheritedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
process.env.BOT_DATA_ROOT = fixtureRoot
process.env.BOT_CONFIG_FILE = path.join(fixtureRoot, 'config.json')
process.env.BOT_TEST_MODE = '1'
process.env.BOT_OFFLINE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ ai: {}, reach: { enabled: true, search: { enabled: true }, jina: { enabled: false } } }))
const originalFetch = globalThis.fetch
let realRequests = 0
globalThis.fetch = async () => { realRequests++; throw new Error('Research fixtures prohibit real network access') }
const { createResearchService, publicSearchQuery } = await import('../src/reach/research.js')
const services = new Set()
function create(dependencies) {
  const service = createResearchService(dependencies)
  services.add(service)
  return service
}
test.afterEach(async () => {
  for (const service of services) service.clear()
  services.clear()
  await new Promise(resolve => setImmediate(resolve))
})
test.after(() => {
  globalThis.fetch = originalFetch
  assert.equal(realRequests, 0)
  assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(os.tmpdir()))
  assert.match(path.basename(fixtureRoot), /^wechaty-research-flow-/)
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const BASE = Date.UTC(2026, 10, 2, 12)
const DAY = 86400000
const GAME_QUERY = '原神最新活动公告'
const MEME_QUERY = '蓝莓启动是什么梗'
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function officialGame(overrides = {}) {
  return [{ title: '原神活动公告', url: 'https://www.mihoyo.com/news/fixture', publishedAt: new Date(BASE).toISOString(),
    snippet: '原神本期活动以公告公布的任务说明为准，参与前查看游戏内活动页面。', ...overrides }]
}
function memeSources() {
  return [
    { title: '蓝莓启动的语境示例', url: 'https://meme-one.example/fixture', snippet: '蓝莓启动是本次测试使用的网络表达，具体含义需要结合前后文理解。' },
    { title: '蓝莓启动的另一份说明', url: 'https://meme-two.example/fixture', snippet: '关于蓝莓启动的用法，两份合成资料在当前语境中给出相同的解释。' },
  ]
}
function readerFor(hits, calls = []) {
  return async (url, options) => {
    calls.push({ url, options })
    const hit = hits.find(row => row.url === url)
    assert.ok(hit, `Unexpected fixture URL: ${url}`)
    return { ok: true, url, text: hit.snippet, publishedAt: hit.publishedAt }
  }
}
function immediate(hits, { now = () => BASE } = {}) {
  const searches = [], reads = []
  const service = create({ now, search: async (query, options) => { searches.push({ query, options }); return { results: structuredClone(hits) } }, reader: readerFor(hits, reads) })
  return { service, searches, reads }
}

test('an unknown meme is recognized by the local planner before public search begins', async () => {
  const fixture = immediate(memeSources()), plans = []
  const result = await fixture.service.prepare({ text: '他们都在说蓝莓启动', context: [{ text: '刚刚看到一个陌生说法' }],
    planner: async input => { plans.push(input); return { needed: true, kind: 'meme', query: '蓝莓启动', game: '' } } })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].hint.needed, false, 'the fixture must require classification rather than a known meme keyword')
  assert.deepEqual(plans[0].context, ['刚刚看到一个陌生说法'])
  assert.equal(result.status, 'fresh')
  assert.equal(result.kind, 'meme')
  assert.equal(fixture.searches.length, 1)
  assert.equal(fixture.searches[0].query, '蓝莓启动')
  assert.equal(result.sources.length, 2)
  assert.match(result.facts, /蓝莓启动/)
})

test('ordinary greetings and personal feelings skip both planning and public transport', async () => {
  let plans = 0, searches = 0, reads = 0
  const service = create({ search: async () => { searches++; return { results: [] } }, reader: async () => { reads++; return { ok: false } } })
  for (const text of ['你好', '谢谢', '早安', '今天好累']) {
    const result = await service.prepare({ text, planner: async () => { plans++; return { needed: true, kind: 'news', query: 'should not run' } } })
    assert.equal(result.status, 'skipped', text)
  }
  assert.equal(plans, 0); assert.equal(searches, 0); assert.equal(reads, 0)
})

test('a game event without a game identity returns missing context without a request', async () => {
  const fixture = immediate(officialGame())
  const result = await fixture.service.prepare({ text: '今天活动奖励是什么' })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'missing-game-context')
  assert.equal(result.facts, '')
  assert.equal(fixture.searches.length, 0)
  assert.equal(fixture.reads.length, 0)
})

test('recent group context supplies the game identity for a follow-up event question', async () => {
  const fixture = immediate(officialGame())
  const result = await fixture.service.prepare({ text: '今天活动奖励怎么拿', context: [{ text: '我们刚刚在聊原神' }] })
  assert.equal(result.status, 'fresh')
  assert.match(fixture.searches[0].query, /原神/)
  assert.match(fixture.searches[0].query, /活动奖励/)
})

test('mixed game servers are ambiguous until the request specifies one server', async () => {
  const hits = [
    ...officialGame({ title: '原神国服活动公告', url: 'https://www.mihoyo.com/news/cn', snippet: '原神国服活动任务已经发布，详细参与方式以游戏内活动页面说明为准。' }),
    ...officialGame({ title: '原神国际服活动公告', url: 'https://www.hoyoverse.com/news/global', snippet: '原神国际服活动任务已经发布，详细参与方式以国际服游戏页面说明为准。' }),
  ]
  const fixture = immediate(hits)
  const ambiguous = await fixture.service.prepare({ text: GAME_QUERY })
  assert.equal(ambiguous.status, 'unavailable')
  assert.equal(ambiguous.reason, 'ambiguous-game-server')
  assert.equal(ambiguous.facts, '')
  const selected = await fixture.service.prepare({ text: '原神国服最新活动公告' })
  assert.equal(selected.status, 'fresh')
  assert.equal(selected.sources.length, 1)
  assert.match(selected.facts, /国服/)
  assert.doesNotMatch(selected.facts, /国际服/)
})

test('an old or undated announcement is not made current by a new fetch timestamp', async () => {
  for (const publishedAt of [new Date(BASE - 15 * DAY).toISOString(), undefined]) {
    const fixture = immediate(officialGame({ publishedAt }))
    const result = await fixture.service.prepare({ text: GAME_QUERY })
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reason, 'no-current-evidence')
    assert.equal(result.facts, '')
    assert.equal(result.fetchedAt, new Date(BASE).toISOString())
  }
})

test('inconsistent event dates from current sources are rejected rather than merged into a claim', async () => {
  const hits = [
    ...officialGame({ url: 'https://www.mihoyo.com/news/date-a', snippet: '原神活动于2026年11月3日开始，完成指定任务可获得测试道具。' }),
    ...officialGame({ url: 'https://www.hoyoverse.com/news/date-b', snippet: '原神活动于2026年11月4日开始，完成指定任务可获得测试道具。' }),
  ]
  const fixture = immediate(hits)
  const result = await fixture.service.prepare({ text: GAME_QUERY })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'conflicting-sources')
  assert.equal(result.facts, '')
})

test('an official current source is fetched first and supersedes conflicting community snippets', async () => {
  const official = officialGame()[0]
  const community = { title: '原神活动讨论', url: 'https://community-fixture.example/news', publishedAt: new Date(BASE).toISOString(), snippet: '社区未经证实地声称活动奖励包含一百件礼物，这段传言不能作为公告结论。' }
  const fixture = immediate([community, official])
  const result = await fixture.service.prepare({ text: GAME_QUERY })
  assert.equal(fixture.reads[0].url, official.url)
  assert.equal(result.status, 'fresh')
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].official, true)
  assert.equal(result.sources[0].url, official.url)
  assert.doesNotMatch(result.facts, /一百件礼物|community-fixture/)
})

test('public terms remove nicknames and account identifiers and reject phone, email and raw private identifiers', () => {
  const raw = '小助手 昵称甲 原神 最新活动 user_123 account_456 room_789 session_321'
  const query = publicSearchQuery(raw, { names: ['昵称甲'], input: raw })
  assert.match(query, /原神/); assert.match(query, /活动/)
  assert.doesNotMatch(query, /昵称甲|小助手|user_123|account_456|room_789|session_321/)
  for (const unsafe of ['原神活动 13900000000', '原神活动 wxid_fixture', '原神活动 user@fixture.example', '原神活动 110101199001010000', '我的密码 原神活动']) assert.equal(publicSearchQuery(unsafe, { input: unsafe }), '', unsafe)
  assert.equal(publicSearchQuery('完全无关的冰箱维修', { input: '原神活动公告' }), '', 'a planner cannot substitute an unrelated public topic')
})

test('grouped phone numbers stay local and ordinary personal statements continue without searching', async () => {
  const fixture = immediate(officialGame())
  assert.equal(publicSearchQuery('原神 138 0013 8000 活动'), '')
  assert.equal((await fixture.service.prepare({ text: '我叫张三，今天有点累' })).status, 'skipped')
  assert.equal((await fixture.service.prepare({ text: '张三的电话 138 0013 8000 新闻', force: true })).reason, 'private-or-invalid-query')
  assert.equal(fixture.searches.length, 0)
})

test('identical planner queries cannot reuse evidence across servers or versions', async () => {
  const fixture = immediate(officialGame({ snippet: '原神国服9.1版本活动内容以官方公告为准，参与活动前查看公告。' }))
  const planner = async () => ({ needed: true, kind: 'game', game: '原神', query: '原神 最新活动' })
  assert.equal((await fixture.service.prepare({ text: '原神国服9.1版本活动', planner })).status, 'fresh')
  assert.equal((await fixture.service.prepare({ text: '原神国际服9.1版本活动', planner })).status, 'unavailable')
  assert.equal((await fixture.service.prepare({ text: '原神国服9.2版本活动', planner })).status, 'unavailable')
  assert.equal(fixture.searches.length, 3)
})

test('a classifier cannot erase an explicitly named game with an empty field', async () => {
  const fixture = immediate(officialGame())
  const result = await fixture.service.prepare({ text: '原神最新活动公告', planner: async () => ({ needed: true, kind: 'game', game: '', query: '原神 活动' }) })
  assert.equal(result.status, 'fresh')
})

test('privacy filtering applies to the query sent to search and blocks a planner-supplied phone number', async () => {
  const fixture = immediate(officialGame())
  const safe = await fixture.service.prepare({ text: '昵称甲 原神最新活动公告', names: ['昵称甲'], planner: async () => ({ needed: true, kind: 'game', game: '原神', query: '昵称甲 原神最新活动公告' }) })
  assert.equal(safe.status, 'fresh')
  assert.doesNotMatch(fixture.searches[0].query, /昵称甲/)
  const before = fixture.searches.length
  const blocked = await fixture.service.prepare({ text: '原神另一条最新活动公告', planner: async () => ({ needed: true, kind: 'game', game: '原神', query: '原神 13900000000 最新活动' }) })
  assert.equal(blocked.reason, 'private-or-invalid-query')
  assert.equal(fixture.searches.length, before)
})

test('fresh event evidence is cached for fifteen minutes with cloned consumer results', async () => {
  let at = BASE
  const fixture = immediate(officialGame(), { now: () => at })
  const first = await fixture.service.prepare({ text: GAME_QUERY })
  assert.equal(first.status, 'fresh')
  first.sources[0].summary = 'consumer mutation'; first.facts = 'consumer mutation'
  at += 900000 - 1
  const cached = await fixture.service.prepare({ text: GAME_QUERY })
  assert.equal(cached.status, 'cached'); assert.equal(cached.cacheHit, true)
  assert.doesNotMatch(cached.facts, /consumer mutation/)
  assert.equal(fixture.searches.length, 1)
  at++
  assert.equal((await fixture.service.prepare({ text: GAME_QUERY })).status, 'fresh')
  assert.equal(fixture.searches.length, 2)
})

test('meme evidence remains cached for twenty-four hours rather than the event TTL', async () => {
  let at = BASE
  const fixture = immediate(memeSources(), { now: () => at })
  assert.equal((await fixture.service.prepare({ text: MEME_QUERY })).status, 'fresh')
  at += DAY - 1
  assert.equal((await fixture.service.prepare({ text: MEME_QUERY })).status, 'cached')
  assert.equal(fixture.searches.length, 1)
  at++
  assert.equal((await fixture.service.prepare({ text: MEME_QUERY })).status, 'fresh')
  assert.equal(fixture.searches.length, 2)
})

test('failed research is negatively cached for only sixty seconds', async () => {
  let at = BASE
  const fixture = immediate([], { now: () => at })
  const first = await fixture.service.prepare({ text: GAME_QUERY })
  assert.equal(first.status, 'unavailable'); assert.equal(first.reason, 'no-results')
  at += 59999
  const cached = await fixture.service.prepare({ text: GAME_QUERY })
  assert.equal(cached.status, 'unavailable'); assert.equal(cached.cacheHit, true)
  assert.equal(fixture.searches.length, 1)
  at++
  await fixture.service.prepare({ text: GAME_QUERY })
  assert.equal(fixture.searches.length, 2)
})

test('simultaneous equal queries share one network job and receive separate result objects', { timeout: 2000 }, async () => {
  const gate = deferred(), started = deferred(), hits = officialGame()
  let searches = 0
  const service = create({ now: () => BASE, search: async () => { searches++; started.resolve(); return gate.promise }, reader: readerFor(hits) })
  const first = service.prepare({ text: GAME_QUERY }), second = service.prepare({ text: GAME_QUERY })
  await started.promise
  assert.equal(searches, 1)
  gate.resolve({ results: hits })
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.status, 'fresh'); assert.deepEqual(a, b)
  assert.notEqual(a, b); assert.notEqual(a.sources[0], b.sources[0])
  a.sources[0].summary = 'mutated by first consumer'
  assert.notEqual(b.sources[0].summary, a.sources[0].summary)
})

test('cancelling one consumer does not abort the shared job needed by another consumer', { timeout: 2000 }, async () => {
  const gate = deferred(), started = deferred(), hits = officialGame()
  const a = new AbortController(), b = new AbortController()
  let transportSignal
  const service = create({ now: () => BASE, search: async (_query, options) => { transportSignal = options.signal; started.resolve(); return gate.promise }, reader: readerFor(hits) })
  const first = service.prepare({ text: GAME_QUERY, signal: a.signal }), second = service.prepare({ text: GAME_QUERY, signal: b.signal })
  await started.promise; a.abort('fixture consumer cancelled')
  assert.equal((await first).reason, 'cancelled')
  assert.equal(transportSignal.aborted, false)
  gate.resolve({ results: hits })
  assert.equal((await second).status, 'fresh')
  assert.equal(transportSignal.aborted, false)
})

test('cancelling the last consumer aborts the transport and does not cache the cancelled job', { timeout: 2000 }, async () => {
  const started = deferred(), hits = officialGame(), a = new AbortController(), b = new AbortController()
  let searches = 0, transportSignal
  const service = create({ now: () => BASE, search: async (_query, options) => {
    searches++
    if (searches > 1) return { results: hits }
    transportSignal = options.signal; started.resolve(); return new Promise(() => {})
  }, reader: readerFor(hits) })
  const first = service.prepare({ text: GAME_QUERY, signal: a.signal }), second = service.prepare({ text: GAME_QUERY, signal: b.signal })
  await started.promise; a.abort(); assert.equal((await first).reason, 'cancelled')
  assert.equal(transportSignal.aborted, false)
  b.abort(); assert.equal((await second).reason, 'cancelled')
  assert.equal(transportSignal.aborted, true)
  assert.equal(transportSignal.reason, 'cancelled')
  assert.equal((await service.prepare({ text: GAME_QUERY })).status, 'fresh')
  assert.equal(searches, 2)
})

test('cancellation while awaiting the local planner cannot start a later network job', { timeout: 2000 }, async () => {
  const planning = deferred(), started = deferred(), controller = new AbortController()
  const fixture = immediate(memeSources())
  const result = fixture.service.prepare({ text: '他们都在说蓝莓启动', signal: controller.signal,
    planner: async () => { started.resolve(); return planning.promise } })
  await started.promise; controller.abort()
  planning.resolve({ needed: true, kind: 'meme', query: '蓝莓启动' })
  assert.equal((await result).reason, 'cancelled')
  assert.equal(fixture.searches.length, 0); assert.equal(fixture.reads.length, 0)
})

test('the total network deadline aborts a stalled search and returns an explicit timeout', { timeout: 2000 }, async () => {
  let signal, reads = 0
  const service = create({ now: () => BASE, search: async (_query, options) => { signal = options.signal; return new Promise(() => {}) }, reader: async () => { reads++; return { ok: false } } })
  const started = Date.now()
  const result = await service.prepare({ text: GAME_QUERY, settings: { timeoutMs: 30 } })
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'timeout')
  assert.equal(signal.aborted, true); assert.equal(signal.reason, 'timeout')
  assert.equal(reads, 0)
  assert.ok(Date.now() - started < 1500, 'a noncooperative transport must not hold the request indefinitely')
})

test('document reads receive only the remaining shared network budget, not a new full timeout', { timeout: 2000 }, async () => {
  let at = BASE, searchOptions
  const reads = [], hits = officialGame()
  const service = create({ now: () => at, search: async (_query, options) => { searchOptions = options; at += 20; return { results: hits } },
    reader: async (_url, options) => { reads.push(options); return new Promise(() => {}) } })
  const result = await service.prepare({ text: GAME_QUERY, settings: { timeoutMs: 30 } })
  assert.equal(result.reason, 'timeout')
  assert.equal(searchOptions.timeoutMs, 30)
  assert.equal(reads.length, 1)
  assert.equal(reads[0].timeoutMs, 10)
  assert.equal(reads[0].deadline, searchOptions.deadline)
  assert.equal(reads[0].signal, searchOptions.signal)
  assert.equal(reads[0].signal.aborted, true)
})

test('clear aborts pending work, prevents stale repopulation and invalidates cached evidence', { timeout: 2000 }, async () => {
  const started = deferred(), hits = officialGame()
  let searches = 0, transportSignal
  const service = create({ now: () => BASE, search: async (_query, options) => {
    searches++
    if (searches > 1) return { results: hits }
    transportSignal = options.signal; started.resolve(); return new Promise(() => {})
  }, reader: readerFor(hits) })
  const pending = service.prepare({ text: GAME_QUERY })
  await started.promise; service.clear()
  assert.equal(transportSignal.aborted, true)
  assert.equal((await pending).reason, 'cancelled')
  assert.equal((await service.prepare({ text: GAME_QUERY })).status, 'fresh')
  assert.equal(searches, 2)
  assert.equal((await service.prepare({ text: GAME_QUERY })).status, 'cached')
  service.clear()
  assert.equal((await service.prepare({ text: GAME_QUERY })).status, 'fresh')
  assert.equal(searches, 3)
})
