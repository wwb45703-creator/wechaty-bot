/** Independent error cases and AstrBot 4.x wire fixtures; never contacts a service. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-bridge-failures-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ ai: {}, astrbot: { enabled: true, baseUrl: 'http://127.0.0.1:6185', timeoutMs: 100 } }))
const config = (await import('../src/config-loader.js')).default
const bridge = await import('../src/reach/astrbot-client.js')
const originalFetch = globalThis.fetch
test.after(() => {
  globalThis.fetch = originalFetch
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.match(path.basename(root), /^wechaty-bridge-failures-/)
  fs.rmSync(root, { recursive: true, force: true })
})
test.beforeEach(() => { config.astrbot.enabled = true })

test('plugin list and market propagate HTTP authentication and backend failures', async () => {
  for (const status of [401, 403, 500]) {
    globalThis.fetch = async () => Response.json({ status: 'error', message: `fixture HTTP ${status}` }, { status })
    await assert.rejects(bridge.listInstalledPlugins(), /401|403|500|认证|授权|fixture/)
    await assert.rejects(bridge.searchMarketPlugins('fixture'), /401|403|500|认证|授权|fixture/)
    const kbs = await bridge.listKnowledgeBases()
    assert.equal(kbs.ok, false, `HTTP ${status} is not a valid empty knowledge base`)
    assert.ok(kbs.error)
  }
})

test('HTTP 200 business errors are never successful mutations or empty lists', async () => {
  globalThis.fetch = async () => Response.json({ status: 'error', message: 'fixture rejected by plugin manager' })
  assert.equal((await bridge.togglePlugin({ name: 'fixture', enabled: true })).ok, false)
  await assert.rejects(bridge.listInstalledPlugins(), /fixture rejected/)
  await assert.rejects(bridge.searchMarketPlugins(), /fixture rejected/)
  assert.equal((await bridge.listKnowledgeBases()).ok, false)
  assert.equal((await bridge.queryKnowledgeBase({ kbId: 'fixture', query: 'test' })).ok, false)
})

test('non-JSON and invalid success shapes are explicit protocol errors', async () => {
  globalThis.fetch = async () => new Response('<html>dashboard login</html>', { headers: { 'content-type': 'text/html' } })
  await assert.rejects(bridge.listInstalledPlugins())
  assert.equal((await bridge.listKnowledgeBases()).ok, false)
  globalThis.fetch = async () => Response.json({ status: 'ok', data: 'invalid-list' })
  await assert.rejects(bridge.listInstalledPlugins())
  assert.equal((await bridge.listKnowledgeBases()).ok, false)
})

test('disabled integration rejects management and retrieval without network side effects', async () => {
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('must not reach transport') }
  config.astrbot.enabled = false
  await assert.rejects(bridge.listInstalledPlugins())
  await assert.rejects(bridge.searchMarketPlugins())
  assert.equal((await bridge.togglePlugin({ name: 'fixture', enabled: false })).ok, false)
  assert.equal((await bridge.listKnowledgeBases()).ok, false)
  assert.equal((await bridge.queryKnowledgeBase({ kbId: 'fixture', query: 'test' })).ok, false)
  assert.equal(requests, 0)
})

test('blank knowledge questions are rejected before a request is sent', async () => {
  let requests = 0
  globalThis.fetch = async () => { requests++; return Response.json({ status: 'ok', data: [] }) }
  assert.equal((await bridge.queryKnowledgeBase({ kbId: 'fixture', query: '  ' })).ok, false)
  assert.equal(requests, 0)
})

test('AstrBot knowledge wire fields normalize IDs, counters and nested retrieval results', async () => {
  let sent
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(url).pathname
    if (pathname.endsWith('/knowledge-bases')) return Response.json({ status: 'ok', data: { items: [
      { kb_id: 'fixture-kb', kb_name: '设备手册', doc_count: 2, chunk_count: 11 },
    ], page: 1, page_size: 20, total: 1 } })
    if (pathname.endsWith('/retrieve')) {
      sent = JSON.parse(options.body)
      return Response.json({ status: 'ok', data: { results: [
        { kb_id: 'fixture-kb', kb_name: '设备手册', doc_id: 'fixture-doc', doc_name: '温控.md', content: '加热温度为 85 度', score: 0.91 },
      ], total: 1, query: '加热温度' } })
    }
    throw new Error(`Unexpected fixture route: ${pathname}`)
  }
  const list = await bridge.listKnowledgeBases()
  assert.equal(list.ok, true)
  assert.equal(list.data[0].id, 'fixture-kb')
  assert.equal(list.data[0].name, '设备手册')
  assert.equal(list.data[0].documents_count, 2)
  assert.equal(list.data[0].chunks_count, 11)
  const result = await bridge.queryKnowledgeBase({ kbId: list.data[0].id, query: '加热温度', topK: 4 })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.chunks[0].content, '加热温度为 85 度')
  assert.equal(sent.top_k, 4)
  assert.deepEqual(sent.kb_names, ['设备手册'])
})
