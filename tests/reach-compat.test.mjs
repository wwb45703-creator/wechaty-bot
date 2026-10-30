import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-reach-compat-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ ai: {}, reach: { enabled: true, search: { enabled: true } }, astrbot: { enabled: false } }))
const { sanitizeQuery, bingSearch, webSearch } = await import('../src/reach/search.js')
const { detectSearchIntent, detectImplicitSearchIntent } = await import('../src/handlers/search.js')
const { matchPlatform } = await import('../src/reach/platforms.js')
const { fetchViaAgentReach, isAgentReachSpecialized } = await import('../src/reach/agent-reach-bridge.js')
const { fetchViaBrowser } = await import('../src/reach/browser.js')
const { runCli } = await import('../src/reach/spawn-utils.js')
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('explicit search triggers retain longest-prefix behavior and bounded query sanitization', () => {
  assert.equal(detectSearchIntent('帮我搜索一下 Ollama'), 'Ollama')
  assert.equal(detectSearchIntent('帮我搜 最近的电影'), '最近的电影')
  assert.equal(detectSearchIntent('搜一下'), null)
  assert.equal(detectSearchIntent('今天天气不错'), null)
  assert.equal(sanitizeQuery('显卡"价格"<2026>'), '显卡 价格 2026')
  assert.equal(sanitizeQuery('a'.repeat(300)).length, 100)
  assert.equal(detectImplicitSearchIntent('今天天气如何'), null)
  assert.equal(detectImplicitSearchIntent('你喜欢动漫吗'), null)
})

test('Bing HTML parser preserves source links, metadata and de-duplicates results with mocked transport', async () => {
  let target
  const html = '<li class="b_algo"><h2><a href="https://example.com/docs">Official &amp; Docs</a></h2><p>Public documentation</p></li>' +
    '<li class="b_algo"><h2><a href="https://example.com/docs">Duplicate</a></h2><p>duplicate</p></li>' +
    '<li class="b_algo"><h2><a href="https://second.example/page">Second</a></h2><p>second snippet</p></li>'
  const client = async (url) => { target = String(url); return new Response(html) }
  const results = await bingSearch('Ollama docs', { numResults: 2, client })
  assert.equal(new URL(target).searchParams.get('q'), 'Ollama docs')
  assert.deepEqual(results.map(item => item.url), ['https://example.com/docs', 'https://second.example/page'])
  assert.equal(results[0].title, 'Official & Docs')
  assert.equal(results[0].snippet, 'Public documentation')
  assert.equal((await webSearch('Ollama docs', { client })).engine, 'bing')
})

test('search forwards cancellation and never treats failed HTTP as a result', async () => {
  const controller = new AbortController()
  let signal
  const pending = bingSearch('test', { signal: controller.signal, client: async (_url, options) => {
    signal = options.signal
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  } })
  controller.abort()
  assert.equal(await pending, null)
  assert.equal(signal.aborted, true)
  assert.equal(await bingSearch('test', { client: async () => new Response('', { status: 503 }) }), null)
})

test('platform routing accepts real suffixes and quarantines uncontrolled alternate transports', async () => {
  assert.equal(matchPlatform('www.bilibili.com'), 'bilibili')
  assert.equal(matchPlatform('bilibili.com.evil.example'), null)
  assert.equal(matchPlatform('notgithub.com'), null)
  assert.equal(matchPlatform('github.com'), 'github')
  assert.equal(isAgentReachSpecialized('https://x.com/author/status/1'), true)
  assert.equal(isAgentReachSpecialized('https://x.com.evil.example/'), false)
  assert.equal(await fetchViaAgentReach('https://example.com'), null)
  assert.equal(await fetchViaBrowser('http://127.0.0.1'), null)
})

test('CLI utility executes only a controlled child, reports missing commands and bounds failures', async () => {
  const result = await runCli(process.execPath, ['-e', 'process.stdout.write("reach-ok")'], { timeoutMs: 2000, maxChars: 100 })
  assert.equal(result.code, 0); assert.equal(result.stdout, 'reach-ok')
  const missing = await runCli('wechaty-regression-nonexistent-command-ef9d', [], { timeoutMs: 2000 })
  assert.notEqual(missing.code, 0)
})
