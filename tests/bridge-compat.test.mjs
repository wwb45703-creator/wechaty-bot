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
  await assert.rejects(bridge.listInstalledPlugins(), /offline fixture/)
  assert.equal((await bridge.chatWithAstrBot({ message: 'plugin command' })).ok, false)
  assert.equal((await bridge.togglePlugin({ name: '', enabled: true })).ok, false)
})

test('auto bridge only targets rooms flagged brain=astrbot behind both master switches', async () => {
  const { isAstrBotBridgeRoom } = await import('../src/handlers/text-response.js')
  config.rooms = [
    { id: 'room-a@chatroom', topic: '房间A', brain: 'astrbot' },
    { topic: '房间B', mode: 'all' },
  ]
  config.astrbot.bridge = { enabled: true, fallbackToLocal: true }
  assert.equal(isAstrBotBridgeRoom({ id: 'room-a@chatroom' }, '房间A'), true)
  assert.equal(isAstrBotBridgeRoom({ id: 'room-b@chatroom' }, '房间B'), false)
  assert.equal(isAstrBotBridgeRoom({ id: 'room-c@chatroom' }, '未登记群'), false)
  assert.equal(isAstrBotBridgeRoom(null, '私聊'), false)
  config.astrbot.bridge.enabled = false
  assert.equal(isAstrBotBridgeRoom({ id: 'room-a@chatroom' }, '房间A'), false)
  config.astrbot.bridge.enabled = true
})

test('bridged room replies come from AstrBot and fall back to the local brain when offline', async () => {  const { produceTextResponse } = await import('../src/handlers/text-response.js')
  config.rooms = [{ id: 'room-a@chatroom', topic: '房间A', brain: 'astrbot', mode: 'mention' }]
  config.astrbot.bridge = { enabled: true, fallbackToLocal: true }
  config.ai = { ...config.ai, fallbackReply: '本地兜底回复' }
  const ctx = {
    room: { id: 'room-a@chatroom' }, topic: '房间A',
    scope: { platform: 'wechat', accountId: 'acc', conversationId: 'room:room-a@chatroom', personaId: 'default', subjectId: 'user-1' },
    epoch: 0, signal: undefined, key: '["wechat","acc","room:room-a@chatroom","default"]', name: '测试者', msg: { id: 'm1' },
  }
  let chatBody
  globalThis.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname
    if (pathname === '/api/v1/plugins') return Response.json({ status: 'ok', data: [] })
    if (pathname === '/api/v1/chat') {
      chatBody = JSON.parse(options.body)
      return new Response('data: {"type":"complete","data":"来自AstrBot的回复"}\n\n')
    }
    throw new Error('unexpected fetch ' + String(url))
  }
  const online = await produceTextResponse(ctx, '你好')
  assert.equal(online.text, '来自AstrBot的回复')
  assert.equal(online.extract, false)
  assert.equal(chatBody.session_id, ctx.key)
  assert.equal(chatBody.username, '测试者')

  globalThis.fetch = async () => { throw new Error('offline') }
  const offline = await produceTextResponse(ctx, '你好')
  assert.equal(offline.text, '本地兜底回复')
  assert.equal(offline.historyKey, undefined)
})

test('mention detection matches config.atNames group card and ignores mentions of others', async () => {
  const { checkRoomTrigger } = await import('../src/handlers/room.js')
  const base = {
    wechaty: { currentUser: { name: () => '鹅（王）', id: 'self-1' } },
    talker: () => ({ self: () => false, id: 'user-1' }),
    mentionSelf: async () => false,
    room: () => null,
  }
  const rc = { mode: 'mention', atNames: ['鹅王（AI代理中）'] }
  const hit = await checkRoomTrigger({ ...base, text: () => '@鹅王（AI代理中） 帮我查天气' }, '@鹅王（AI代理中） 帮我查天气', rc)
  assert.equal(hit.triggered, true)
  assert.equal(hit.triggerReason, 'mention')
  const miss = await checkRoomTrigger({ ...base, text: () => '@张三 你怎么看' }, '@张三 你怎么看', rc)
  assert.equal(miss.triggered, false)
})

test('auto-bridge replies are clipped to a single sentence', async () => {
  const { firstSentence, produceTextResponse } = await import('../src/handlers/text-response.js')
  assert.equal(firstSentence('嗯。早点休息吧。'), '嗯。')
  assert.equal(firstSentence('这事儿吧？我看行！就这样。'), '这事儿吧？')
  assert.equal(firstSentence('行吧'), '行吧')

  config.rooms = [{ id: 'room-a@chatroom', topic: '房间A', brain: 'astrbot', mode: 'mention' }]
  config.astrbot.bridge = { enabled: true, fallbackToLocal: true }
  const ctx = {
    room: { id: 'room-a@chatroom' }, topic: '房间A',
    scope: { platform: 'wechat', accountId: 'acc', conversationId: 'room:room-a@chatroom', personaId: 'default', subjectId: 'user-1' },
    epoch: 0, signal: undefined, key: '["wechat","acc","room:room-a@chatroom","default"]', name: '测试者', msg: { id: 'm2' },
  }
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname
    if (pathname === '/api/v1/plugins') return Response.json({ status: 'ok', data: [] })
    if (pathname === '/api/v1/chat') return new Response('data: {"type":"complete","data":"嗯。早点休息吧。"}\n\n')
    throw new Error('unexpected fetch ' + String(url))
  }
  const r = await produceTextResponse(ctx, '今天好累啊')
  assert.equal(r.text, '嗯。')
})
