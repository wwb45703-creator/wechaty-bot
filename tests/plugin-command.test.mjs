/** Exercise the actual text-response command router with an isolated transport. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-plugin-command-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ ai: {}, astrbot: { enabled: true, baseUrl: 'http://127.0.0.1:6185' }, personas: { fixture: 'fixture' } }))
const config = (await import('../src/config-loader.js')).default
const { produceTextResponse } = await import('../src/handlers/text-response.js')
const originalFetch = globalThis.fetch
let sentChat = null, requests = 0
const ctx = { key: 'fixture-session', name: 'fixture-user', msg: {}, scope: { platform: 'wechat', accountId: 'fixture-account', conversationId: 'private:fixture', personaId: 'fixture', subjectId: 'fixture-user' } }
test.beforeEach(() => {
  config.astrbot.enabled = true; sentChat = null; requests = 0
  globalThis.fetch = async (url, options = {}) => {
    requests++
    if (String(url).endsWith('/plugins')) return Response.json({ status: 'ok', data: [{ name: 'fixture-weather', display_name: '天气工具', desc: 'fixture description' }] })
    if (String(url).endsWith('/chat')) { sentChat = JSON.parse(options.body); return new Response('data: {"type":"complete","data":"fixture tool reply"}\n\n') }
    throw new Error(`Unexpected route ${url}`)
  }
})
test.after(() => {
  globalThis.fetch = originalFetch
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.match(path.basename(root), /^wechaty-plugin-command-/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('explicit plugin list supports the slash command and never invokes chat', async () => {
  for (const command of ['/插件 列表', '/astrbot list', '插件 列表']) {
    const result = await produceTextResponse(ctx, command)
    assert.match(result.text, /天气工具/)
    assert.equal(result.learn, false)
    assert.equal(sentChat, null)
  }
})

test('explicit wrappers forward the actual plugin command and preserve the scoped session', async () => {
  for (const command of ['/插件 /weather 上海', '/astrbot /weather 上海']) {
    const result = await produceTextResponse(ctx, command)
    assert.equal(sentChat.message, '/weather 上海')
    assert.equal(sentChat.session_id, 'fixture-session')
    assert.equal(sentChat.username, 'fixture-user')
    assert.equal(result.text, 'fixture tool reply')
    assert.equal(result.extract, false)
  }
})

test('disabled explicit plugin commands show a clear response without a network call', async () => {
  config.astrbot.enabled = false
  const result = await produceTextResponse(ctx, '/插件 /weather')
  assert.match(result.text, /未启用/)
  assert.equal(result.learn, false)
  assert.equal(requests, 0)
})

test('empty wrapper shows usage and an offline tool does not fabricate a successful reply', async () => {
  assert.match((await produceTextResponse(ctx, '/插件')).text, /用法/)
  assert.equal(requests, 0)
  globalThis.fetch = async () => { throw new Error('offline fixture') }
  const result = await produceTextResponse(ctx, '/插件 /weather')
  assert.match(result.text, /暂时不可用/)
  assert.equal(result.learn, false)
})
