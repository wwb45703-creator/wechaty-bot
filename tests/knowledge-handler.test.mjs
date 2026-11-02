import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-knowledge-handler-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({
  ai: { model: 'fixture', replyDelaySeconds: { min: 0, max: 0 } },
  defaultPersona: 'A', personas: { A: 'fixture' }, private: { enabled: true, cooldownSeconds: 0 },
  rooms: [{ id: 'fixture-room', mode: 'mention', prefixes: ['/'], cooldownSeconds: 0, atSender: false }],
  astrbot: { enabled: false }, reach: { enabled: false }, memory: { enabled: true },
}))
const config = (await import('../src/config-loader.js')).default
const store = await import('../src/knowledge/store.js')
const { initAi, conversations } = await import('../src/ai.js')
const { handlePrivateMessage } = await import('../src/handlers/private.js')
const { handleRoomMessage } = await import('../src/handlers/room.js')
const originalFetch = globalThis.fetch
let modelCalls = 0, networkCalls = 0
initAi(config, { provider: { generate() { modelCalls++; throw new Error('knowledge commands must not invoke a model') } } })
globalThis.fetch = async () => { networkCalls++; throw new Error('knowledge commands must be offline') }
const sent = []
function message(id, text) {
  return { id, text: () => text, self: () => false, mentionSelf: async () => false,
    talker: () => ({ id: 'fixture-user', name: () => 'fixture-user', alias: async () => '', self: () => false }),
    wechaty: { currentUser: { id: 'fixture-account', name: () => 'fixture-bot' } },
    say: async text => sent.push(text) }
}
test.after(() => {
  globalThis.fetch = originalFetch
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.match(path.basename(root), /^wechaty-knowledge-handler-/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('real private and triggered room handlers answer imported knowledge without model or external service', async () => {
  const kb = store.createKnowledgeBase({ name: '设备手册' })
  store.importKnowledgeDocument({ kbId: kb.id, name: '设备.md', text: '实验装置电源为 24V，机械臂额定速度为每秒 12 毫米。' })
  await handlePrivateMessage(message('private-query', '/知识库 电源'))
  assert.equal(sent.length, 1)
  assert.match(sent[0], /24V/)
  assert.match(sent[0], /设备手册/)
  const room = { id: 'fixture-room', topic: async () => 'fixture-room', say: async text => sent.push(text) }
  await handleRoomMessage(message('room-query', '/知识库 机械臂额定速度'), room)
  assert.equal(sent.length, 2)
  assert.match(sent[1], /12 毫米/)
  assert.equal(modelCalls, 0)
  assert.equal(networkCalls, 0)
  assert.equal(conversations.size, 0, 'document answers must not become social model history')
  store.updateKnowledgeBase({ id: kb.id, enabled: false })
  await handlePrivateMessage(message('disabled-query', '/知识库 电源'))
  assert.match(sent[2], /没有找到/)
  assert.doesNotMatch(sent[2], /24V/)
})

test('knowledge commands still obey the private message admission switch', async () => {
  config.private.enabled = false
  const before = sent.length
  await handlePrivateMessage(message('disabled-private', '/知识库 电源'))
  assert.equal(sent.length, before)
  assert.equal(networkCalls, 0)
  assert.equal(modelCalls, 0)
})
