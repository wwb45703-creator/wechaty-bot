import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-bridge-compat-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ ai: {}, astrbot: { enabled: true, baseUrl: 'http://127.0.0.1:6185', timeoutMs: 100 } }))
const config = (await import('../src/config-loader.js')).default
const bridge = await import('../src/reach/astrbot-client.js')
const originalFetch = globalThis.fetch
test.after(() => { globalThis.fetch = originalFetch; fs.rmSync(root, { recursive: true, force: true }) })

test('bridge SSE parsing chooses complete reply and retains partial-only fallback', async () => {
  let sent
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body)
    return new Response('data: {"type":"plain","data":"部分"}\n\ndata: {"type":"complete","data":"最终回复"}\n\n')
  }
  assert.deepEqual(await bridge.chatWithAstrBot({ message: '插件 帮助', sessionId: 'scope-one', username: 'fixture' }), { ok: true, reply: '最终回复' })
  assert.equal(sent.session_id, 'scope-one')
  globalThis.fetch = async () => new Response('data: {"type":"plain","data":"第一段"}\n\ndata: {"type":"plain","data":"第二段"}\n\n')
  assert.equal((await bridge.chatWithAstrBot({ message: '/help' })).reply, '第一段第二段')
})

test('mocked plugin and knowledge APIs keep metadata and bounded query payloads', async () => {
  let payload
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname
    if (pathname.endsWith('/plugins')) return Response.json({ status: 'ok', data: [{ name: 'weather', activated: true }] })
    if (pathname.endsWith('/knowledge-bases')) return Response.json({ status: 'ok', data: { items: [{ id: 'public-docs' }] } })
    if (pathname.endsWith('/retrieve')) { payload = JSON.parse(options.body); return Response.json({ status: 'ok', data: [{ content: 'public snippet' }] }) }
    if (pathname.endsWith('/enabled')) { payload = JSON.parse(options.body); return Response.json({ status: 'ok' }) }
    return new Response('', { status: 404 })
  }
  assert.equal((await bridge.listInstalledPlugins())[0].name, 'weather')
  const status = await bridge.getAstrBotStatus()
  assert.equal(status.alive, true); assert.equal(status.pluginCount, 1); assert.equal(status.kbCount, 1)
  assert.equal((await bridge.queryKnowledgeBase({ kbId: 'public-docs', query: 'q'.repeat(2000), topK: 100 })).ok, true)
  assert.equal(payload.query.length, 1000); assert.equal(payload.top_k, 20)
  assert.equal((await bridge.togglePlugin({ name: 'weather', enabled: false })).ok, true)
  assert.equal(payload.enabled, false)
})

test('disabled bridge and offline failures return explicit failure without invoking the disabled service', async () => {
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('offline fixture') }
  config.astrbot.enabled = false
  assert.equal(await bridge.isAstrBotAlive(), false)
  assert.equal((await bridge.chatWithAstrBot({ message: 'plugin command' })).ok, false)
  assert.equal(requests, 0)
  config.astrbot.enabled = true
  assert.deepEqual(await bridge.listInstalledPlugins(), [])
  assert.equal((await bridge.chatWithAstrBot({ message: 'plugin command' })).ok, false)
  assert.equal((await bridge.togglePlugin({ name: '', enabled: true })).ok, false)
})
