import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recipientAllowed, directedTextReason } from '../src/reply-policy.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-directed-policy-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
const conf = { defaultPersona: '鹅王', personas: { 鹅王: '角色' }, private: { enabled: false },
  replyPolicy: { strictRoomIds: true, directedOnly: true, allowPrivate: false, allowAutonomous: false },
  rooms: [{ id: 'r1', topic: '允许群', mode: 'mention', atNames: ['鹅王'], wakeWords: ['小助手'], cooldownSeconds: 0 }],
  ai: { replyDelaySeconds: { min: 0, max: 0 } } }
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify(conf))
const { admitMessage, createMessagingRuntime } = await import('../src/messaging.js')
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('directed policy permits fixed IDs only and blocks autonomous delivery', () => {
  assert.equal(recipientAllowed(conf, ''), false)
  assert.equal(recipientAllowed(conf, 'r1'), true)
  assert.equal(recipientAllowed(conf, 'other'), false)
  for (const kind of ['welcome', 'cron']) assert.equal(recipientAllowed(conf, 'r1', kind), false)
  const options = { names: ['鹅王', '鹅（王）'], wakeWords: ['小助手'], conf }
  for (const text of ['@鹅王 你好', '小助手，查查这个', '/知识库 电源', '/插件 列表', '搜索活动公告', '忘记我']) assert.ok(directedTextReason(text, options), text)
  for (const text of ['你好', '@另一个人 你好', '他把@鹅王 当成了名字', '“@鹅王 你好”', '我提到小助手', '@鹅王同名者 你好']) assert.equal(directedTextReason(text, options), '', text)
})

test('denied recipients perform no lookups, model calls, network work or writes', async () => {
  let sideEffects = 0
  const person = { id: 'u', name: () => '用户', self: () => false }
  const msg = { id: 'm', self: () => false, talker: () => person }
  const social = { captureEpoch() { sideEffects++; return 0 } }
  assert.equal(await admitMessage(msg, null, conf, social), null)
  assert.equal(await admitMessage(msg, { id: 'other', topic() { sideEffects++ } }, conf, social), null)
  const runtime = createMessagingRuntime({ conf, dataRoot: root, socialApi: social })
  for (const kind of ['text', 'image', 'link', 'search', 'emoticon', 'welcome', 'cron']) {
    const outcome = await runtime.process({ msg, room: { id: 'other' }, kind, producer() { sideEffects++ } })
    assert.equal(outcome.status, 'denied')
  }
  assert.equal(sideEffects, 0)
  runtime.dispose()
})

test('outbound policy is checked again after generation', async () => {
  const mutable = structuredClone(conf), sent = []
  const person = { id: 'u', name: () => '用户', alias: async () => '', self: () => false }
  const room = { id: 'r1', topic: async () => '允许群', alias: async () => '', say: async text => sent.push(text) }
  const msg = { id: 'egress', self: () => false, talker: () => person, text: () => '@鹅王 你好', room: () => room,
    mentionSelf: async () => false, wechaty: { currentUser: { id: 'bot', name: () => '鹅王' } } }
  const social = { captureEpoch: () => 0, isEpochCurrent: () => true, commitInteraction: async () => null }
  const runtime = createMessagingRuntime({ conf: mutable, dataRoot: path.join(root, 'egress'), socialApi: social, sleep: async () => {} })
  const r = await runtime.process({ msg, room, producer: async () => { mutable.rooms = []; return { text: '不应发出', learn: false } } })
  assert.equal(r.confirmedCount, 0)
  assert.equal(r.status, 'denied')
  assert.deepEqual(sent, [])
  runtime.dispose()
})
