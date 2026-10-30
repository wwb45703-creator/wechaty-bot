import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-handler-integration-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ defaultPersona: 'A', personas: { A: '你叫A', B: '你叫B' },
  private: { enabled: true, cooldownSeconds: 0, dailyLimit: 0 }, memory: { enabled: true },
  rooms: [{ id: 'group-1', topic: '同名', mode: 'all', cooldownSeconds: 0 }], roomDailyLimit: 0,
  links: { enabled: false }, reach: { enabled: false }, ai: { model: 'test', maxHistory: 8, replyDelaySeconds: { min: 0, max: 0 } } }))
const config = (await import('../src/config-loader.js')).default
const { initAi, conversations } = await import('../src/ai.js')
const { handlePrivateMessage } = await import('../src/handlers/private.js')
const { handleRoomMessage } = await import('../src/handlers/room.js')
const { getSocialState } = await import('../src/social/index.js')
const { chatKeyFor } = await import('../src/messaging.js')
const captured = [], sent = []
let generate = async ({ messages }) => {
  captured.push(messages)
  if (messages[0].content.includes('只提取用户明确自述')) return { text: '{"facts":["喜欢烘焙面包"]}' }
  return { text: '记下了，面包闻起来很香' }
}
initAi(config, { provider: { generate: (args) => generate(args) } })
function msg(id, text, user = 'user-1', failSend = false) {
  return { id, text: () => text, self: () => false, mentionSelf: async () => false,
    talker: () => ({ id: user, name: () => user, alias: async () => '', self: () => false }),
    wechaty: { currentUser: { id: 'integration-account', name: () => 'bot' } },
    say: async (line) => { if (failSend) throw new Error('send ack unavailable'); sent.push(line) } }
}
const scope = (subjectId, personaId = 'A', conversationId = `private:${subjectId}`) => ({ platform: 'wechat', accountId: 'integration-account', conversationId, personaId, subjectId })
const flush = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)) }

test('real handler confirms history and growth only after transport success; user-only extraction', async () => {
  await handlePrivateMessage(msg('success', '我喜欢烘焙面包'))
  await flush()
  const state = getSocialState(scope('user-1'))
  assert.equal(state.relationship.interactionCount, 1)
  assert.ok(state.memory.facts.some((f) => f.text.includes('烘焙面包')))
  assert.equal(conversations.get(chatKeyFor(scope('user-1'))).at(-1).role, 'assistant')
  const extraction = captured.find((messages) => messages[0].content.includes('只提取用户明确自述'))
  assert.match(extraction[1].content, /我喜欢烘焙面包/)
  assert.doesNotMatch(extraction[1].content, /面包闻起来很香/)
  await handlePrivateMessage(msg('send-failed', '我喜欢面包', 'failed-user', true))
  await flush()
  assert.equal(getSocialState(scope('failed-user')).relationship.interactionCount, 0)
  assert.ok(conversations.get(chatKeyFor(scope('failed-user'))).every((entry) => entry.role !== 'assistant'))
})

test('real role switches retain each role history and prevent memory leaking to another user', async () => {
  const keyA = chatKeyFor(scope('user-1'))
  const previousHistory = JSON.stringify(conversations.get(keyA))
  await handlePrivateMessage(msg('switch-b', '变成B'))
  await handlePrivateMessage(msg('role-b-message', '你叫什么'))
  assert.equal(JSON.stringify(conversations.get(keyA)), previousHistory)
  const keyB = chatKeyFor(scope('user-1', 'B'))
  assert.equal(conversations.get(keyB).length, 2)
  await handlePrivateMessage(msg('switch-a', '变成A'))
  assert.equal(JSON.stringify(conversations.get(keyA)), previousHistory)
  assert.equal(getSocialState(scope('other-user')).memory.facts.length, 0)
})

test('forget during real inference immediately revokes pending context and late facts', async () => {
  let release, began
  const gate = new Promise((r) => { release = r }), started = new Promise((r) => { began = r })
  const normal = generate
  generate = async (args) => {
    const input = args.messages.at(-1).content
    if (input === '请用老记忆回答') { began(); await gate; return { text: '绝对不应该发送这条旧答案' } }
    return normal(args)
  }
  const before = sent.length
  const pending = handlePrivateMessage(msg('inference', '请用老记忆回答'))
  await started
  const forgetting = handlePrivateMessage(msg('forget', '忘记我'))
  await flush()
  assert.equal(getSocialState(scope('user-1')).memory.facts.length, 0)
  release()
  await Promise.all([pending, forgetting]); await flush()
  assert.ok(!sent.slice(before).some((line) => line.includes('旧答案')))
  assert.equal(getSocialState(scope('user-1')).relationship.interactionCount, 0)
  assert.equal(getSocialState(scope('user-1', 'B')).relationship.interactionCount, 0)
  assert.equal(conversations.has(chatKeyFor(scope('user-1'))), false)
})

test('actual room handler keys use room IDs, so equal names cannot share history', async () => {
  config.rooms.push({ id: 'group-2', topic: '同名', mode: 'all', cooldownSeconds: 0 })
  const room = (id) => ({ id, topic: async () => '同名', say: async (line) => sent.push(line) })
  await handleRoomMessage(msg('group-a', '你好', 'group-user'), room('group-1'))
  await handleRoomMessage(msg('group-b', '第二个群', 'group-user'), room('group-2'))
  const key1 = chatKeyFor(scope('group-user', 'A', 'room:group-1')), key2 = chatKeyFor(scope('group-user', 'A', 'room:group-2'))
  assert.notEqual(key1, key2)
  assert.equal(conversations.get(key1).length, 2); assert.equal(conversations.get(key2).length, 2)
})
