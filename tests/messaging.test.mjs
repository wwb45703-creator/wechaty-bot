import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-messaging-'))
process.env.BOT_DATA_ROOT = fixtureRoot
process.env.BOT_CONFIG_FILE = path.join(fixtureRoot, 'config.json')
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ defaultPersona: 'A', personas: { A: '角色A', B: '角色B' }, private: { enabled: true }, rooms: [], ai: {} }))
const { createMessagingRuntime, admitMessage, roomConfigFor, chatKeyFor } = await import('../src/messaging.js')
const { createRateLimiter } = await import('../src/rate-limit.js')
const { createOnMessage } = await import('../src/handlers/on-message.js')
const config = (await import('../src/config-loader.js')).default
const { handlePersonaCommand, getActivePersonaName } = await import('../src/persona-commands.js')

function fixture(overrides = {}) {
  const dataRoot = fs.mkdtempSync(path.join(fixtureRoot, 'case-'))
  const conf = { private: { enabled: true, cooldownSeconds: 0, dailyLimit: 10 }, rooms: [{ id: 'r1', topic: '同名', mode: 'all', cooldownSeconds: 0 }], roomDailyLimit: 10,
    ai: { replyDelaySeconds: { min: 0, max: 0 } }, ...overrides }
  let revision = 0, role = 'A'
  const committed = [], enriched = [], extracted = [], history = []
  const socialApi = { captureEpoch: () => revision, isEpochCurrent: (_, token) => token === revision,
    forgetSubject: async () => { revision++ }, commitInteraction: async (event) => { committed.push(event); return 'ev1' },
    enrichInteraction: async (event) => enriched.push(event) }
  const options = { conf, dataRoot, socialApi, personaName: () => role, sleep: async () => {},
    extract: async (args) => { extracted.push(args); return [{ text: '喜欢面包', key: 'preference' }] },
    onConfirmed: async (row) => history.push(row) }
  const runtime = createMessagingRuntime(options)
  const sends = []
  const contact = { id: 'u1', name: () => '测试用户', alias: async () => '', self: () => false }
  const room = { id: 'r1', topic: async () => '同名', say: async (text) => sends.push(text) }
  function msg(id, text = '你好', target = null) { return { id, text: () => text, talker: () => contact, room: () => target,
    type: () => 7, self: () => false, wechaty: { currentUser: { id: 'bot1', name: () => '机器人' } }, say: async (line) => sends.push(line) } }
  return { runtime, options, conf, msg, room, contact, sends, committed, enriched, extracted, history, setRole: (value) => { role = value } }
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

test('all message kinds share enabled/allowlist admission before any side effect', async () => {
  for (const kind of ['text', 'search', 'link', 'image', 'emoticon', 'cron', 'welcome']) {
    const f = fixture({ private: { enabled: false } })
    let runs = 0
    const result = await f.runtime.process({ msg: f.msg(kind), kind, producer: async () => { runs++; return '不应发送' } })
    assert.equal(result.status, 'denied'); assert.equal(runs, 0); assert.equal(f.sends.length, 0)
  }
  const f = fixture({ private: { enabled: true, whitelist: [{ id: 'other', name: '测试用户' }] } })
  assert.equal(await admitMessage(f.msg('wl'), null, f.conf), null)
  assert.equal(roomConfigFor({ rooms: [{ id: 'r2', topic: '同名' }] }, '同名', 'r1'), undefined)
  assert.equal(roomConfigFor({ rooms: [{ topic: '同名' }, { topic: '同名' }] }, '同名', 'r1'), undefined)
})

test('concurrent work consumes one reserved quota per response, across all kinds', async () => {
  const f = fixture({ private: { enabled: true, cooldownSeconds: 0, dailyLimit: 1 } })
  const started = deferred(), gate = deferred()
  const first = f.runtime.process({ msg: f.msg('m1'), producer: async () => { started.resolve(); await gate.promise; return '一 ||| 二' } })
  await started.promise
  const second = f.runtime.process({ msg: f.msg('m2'), kind: 'image', producer: async () => '第三条' })
  gate.resolve()
  assert.equal((await first).confirmedCount, 2)
  assert.equal((await second).status, 'limited')
  const counts = Object.values(f.runtime.limiter.snapshot().counts)
  assert.deepEqual(counts, [1]); assert.equal(f.committed.filter((event) => event.sendOutcome.confirmedCount > 0).length, 1)
})

test('rate reservation prevents admission races and persists unsettled holds', () => {
  const dir = fs.mkdtempSync(path.join(fixtureRoot, 'rate-')), file = path.join(dir, 'rate.json')
  const rate = createRateLimiter({ file }), limits = [{ key: 'group', dailyLimit: 1, cooldownSeconds: 0 }]
  const reservation = rate.reserve(limits)
  assert.equal(reservation.allowed, true); assert.equal(rate.reserve(limits).allowed, false)
  assert.equal(createRateLimiter({ file }).reserve(limits).allowed, false)
  rate.settle(reservation.id, false); assert.equal(rate.reserve(limits).allowed, true)
})

test('durable dedup suppresses replay after success and unconfirmed native send', async () => {
  const f = fixture()
  await f.runtime.process({ msg: f.msg('done'), producer: async () => '收到' })
  const restored = createMessagingRuntime(f.options)
  assert.equal((await restored.process({ msg: f.msg('done'), producer: async () => assert.fail('replayed') })).status, 'duplicate')
  const uncertain = f.msg('unknown'); uncertain.say = async () => { throw new Error('ack lost') }
  assert.equal((await restored.process({ msg: uncertain, producer: async () => '也许发出了' })).status, 'unknown')
  const restoredAgain = createMessagingRuntime(f.options)
  assert.equal((await restoredAgain.process({ msg: uncertain, producer: async () => assert.fail('unknown replay') })).status, 'duplicate')
  assert.equal(f.committed.filter((event) => event.sendOutcome.confirmedCount > 0).length, 1)
})

test('partial sends commit only confirmed text once, do not claim unsent bubbles', async () => {
  const f = fixture(); let calls = 0
  const msg = f.msg('partial'); msg.say = async (line) => { if (++calls === 2) throw new Error('network'); f.sends.push(line) }
  const result = await f.runtime.process({ msg, producer: async (ctx) => ({ text: '甲 ||| 乙 ||| 丙', historyKey: ctx.key }) })
  assert.equal(result.status, 'partial'); assert.equal(result.confirmedCount, 1); assert.equal(calls, 2)
  assert.equal(f.committed.length, 1); assert.deepEqual(f.committed[0].sendOutcome.sentTexts, ['甲'])
  assert.equal(f.history[0].reply, '甲'); assert.deepEqual(Object.values(f.runtime.limiter.snapshot().counts), [1])
})

test('forget bypasses active inference and invalidates it and already queued old-context work', async () => {
  const f = fixture(), gate = deferred(), started = deferred()
  const first = f.runtime.process({ msg: f.msg('thinking'), producer: async () => { started.resolve(); await gate.promise; return '不应出现的旧记忆' } })
  await started.promise
  const queued = f.runtime.process({ msg: f.msg('old-queued'), producer: async () => assert.fail('old queued ran') })
  await new Promise((r) => setImmediate(r))
  const forgotten = f.runtime.process({ msg: f.msg('forget', '忘记我'), forget: true, producer: async () => ({ text: '已忘记', learn: false }) })
  await new Promise((r) => setImmediate(r))
  gate.resolve()
  assert.equal((await first).status, 'stale'); assert.equal((await queued).status, 'stale')
  assert.equal((await forgotten).status, 'confirmed'); assert.deepEqual(f.sends, ['已忘记']); assert.equal(f.committed.length, 0)
})

test('stable room IDs isolate same-name rooms and survive rename; roles keep separate keys', async () => {
  const f = fixture({ rooms: [{ id: 'r1', topic: '同名', cooldownSeconds: 0 }, { id: 'r2', topic: '同名', cooldownSeconds: 0 }] })
  const r2 = { ...f.room, id: 'r2' }, keys = []
  await f.runtime.process({ msg: f.msg('same', '甲', f.room), room: f.room, producer: async (ctx) => { keys.push(ctx.key); return '甲' } })
  await f.runtime.process({ msg: f.msg('same', '乙', r2), room: r2, producer: async (ctx) => { keys.push(ctx.key); return '乙' } })
  f.room.topic = async () => '改名'
  await f.runtime.process({ msg: f.msg('renamed', '丙', f.room), room: f.room, producer: async (ctx) => { keys.push(ctx.key); return '丙' } })
  f.setRole('B')
  await f.runtime.process({ msg: f.msg('role-b', '丁', f.room), room: f.room, producer: async (ctx) => { keys.push(ctx.key); return '丁' } })
  assert.notEqual(keys[0], keys[1]); assert.equal(keys[0], keys[2]); assert.notEqual(keys[2], keys[3])
})

test('persona command switches without deleting previous role history, with canonical scope', async () => {
  const scope = { accountId: 'roles-bot', conversationId: 'room:r1', subjectId: 'u1' }
  let reply
  assert.equal(await handlePersonaCommand({ text: '变成B', ref: scope, reply: async (text) => { reply = text } }), true)
  assert.equal(getActivePersonaName(scope), 'B'); assert.match(reply, /保留/)
  await handlePersonaCommand({ text: '变成A', ref: scope, reply: async () => {} })
  assert.equal(getActivePersonaName(scope), 'A')
})

test('dispatcher admits empty image metadata and denies disabled rooms for every branch', async () => {
  const f = fixture(), seen = []
  const handlers = Object.fromEntries(['private', 'room', 'image', 'emoticon', 'link', 'search'].map((name) => [name, async () => seen.push(name)]))
  const dispatch = createOnMessage({ conf: f.conf, handlers, typeMap: { Text: 7, Unknown: 0, Image: 6, Emoticon: 5 }, trigger: async () => ({ triggered: true }) })
  const image = f.msg('image', ''); image.type = () => 6
  await dispatch(image); assert.deepEqual(seen, ['image'])
  f.conf.rooms[0].enabled = false
  for (const type of [7, 6, 5]) { const msg = f.msg(`disabled-${type}`, 'ding', f.room); msg.type = () => type; await dispatch(msg) }
  assert.deepEqual(seen, ['image'])
})


test('configured array delay applies before first bubble and inter-bubble delay stays bounded', async () => {
  const f = fixture({ ai: { replyDelaySeconds: [2, 2] } }), waits = []
  const runtime = createMessagingRuntime({ ...f.options, sleep: async (ms) => { waits.push(ms) } })
  await runtime.process({ msg: f.msg('delay'), producer: async () => '第一 ||| 第二' })
  assert.equal(waits[0], 2000); assert.ok(waits[1] >= 400 && waits[1] <= 700); assert.equal(waits.length, 2)
})

test('forget cancels the first-bubble wait without sending a stale response', async () => {
  const f = fixture({ ai: { replyDelaySeconds: [20, 20] } }), started = deferred()
  const runtime = createMessagingRuntime({ ...f.options, sleep: async () => { started.resolve(); await new Promise(() => {}) } })
  const pending = runtime.process({ msg: f.msg('delayed'), producer: async () => '旧回复' })
  await started.promise
  f.conf.ai.replyDelaySeconds = [0, 0]
  const forgotten = runtime.process({ msg: f.msg('delay-forget', '忘记我'), forget: true, producer: async () => ({ text: '已忘记', learn: false }) })
  assert.equal((await pending).status, 'stale'); await forgotten
  assert.deepEqual(f.sends, ['已忘记'])
})

test('forget while awaiting native acknowledgement stops subsequent bubbles and old growth', async () => {
  const f = fixture(), sending = deferred(), ack = deferred()
  const old = f.msg('ack-in-flight'); old.say = async (line) => { sending.resolve(); await ack.promise; f.sends.push(line) }
  const pending = f.runtime.process({ msg: old, producer: async () => '已提交的一条 ||| 不应继续发' })
  await sending.promise
  const forgotten = f.runtime.process({ msg: f.msg('ack-forget', '忘记我'), forget: true, producer: async () => ({ text: '已忘记', learn: false }) })
  await new Promise((r) => setImmediate(r)); ack.resolve()
  const outcome = await pending; await forgotten
  assert.equal(outcome.status, 'stale'); assert.equal(outcome.confirmedCount, 1)
  assert.deepEqual(f.sends, ['已提交的一条', '已忘记']); assert.equal(f.committed.length, 0)
})

test('entry epoch is captured before slow alias lookup, so earlier input cannot revive after forget', async () => {
  const f = fixture(), lookingUp = deferred(), alias = deferred()
  const old = f.msg('slow-admission')
  old.talker = () => ({ ...f.contact, alias: async () => { lookingUp.resolve(); await alias.promise; return '' } })
  let generated = false
  const pending = f.runtime.process({ msg: old, producer: async () => { generated = true; return '旧输入' } })
  await lookingUp.promise
  await f.runtime.process({ msg: f.msg('lookup-forget', '忘记我'), forget: true, producer: async () => ({ text: '已忘记', learn: false }) })
  alias.resolve()
  assert.equal((await pending).status, 'stale'); assert.equal(generated, false)
})

test('generation and transport failures are audit events with zero growth', async () => {
  const f = fixture()
  await f.runtime.process({ msg: f.msg('generation-failure'), producer: async () => { throw new Error('bad model') } })
  assert.equal(f.committed.length, 1); assert.equal(f.committed[0].sendOutcome.confirmedCount, 0)
  assert.equal(f.committed[0].sendOutcome.failed, true)
  assert.deepEqual(Object.values(f.runtime.limiter.snapshot().counts), [])
})

test('preferences apply only to confirmed replies using the captured epoch', async () => {
  const f = fixture(), changes = []
  f.options.socialApi.recordPreference = (...args) => changes.push(args)
  await f.runtime.process({ msg: f.msg('pref-success'), producer: async () => ({ text: '好的', preference: { kind: 'length', value: 'short' } }) })
  const bad = f.msg('pref-failed'); bad.say = async () => { throw new Error('ack lost') }
  await f.runtime.process({ msg: bad, producer: async () => ({ text: '好的', preference: { kind: 'suffix', value: '喵' } }) })
  assert.equal(changes.length, 1); assert.equal(changes[0][1].kind, 'length'); assert.equal(changes[0][2], 0)
})

test('forget also aborts background fact extraction after the reply has settled', async () => {
  const f = fixture(), started = deferred(), complete = deferred()
  let extractionSignal
  const runtime = createMessagingRuntime({ ...f.options, extract: async ({ signal }) => { extractionSignal = signal; started.resolve(); await complete.promise; return ['旧事实'] } })
  await runtime.process({ msg: f.msg('background'), producer: async () => '收到' }); await started.promise
  await runtime.process({ msg: f.msg('background-forget', '忘记我'), forget: true, producer: async () => ({ text: '已忘记', learn: false }) })
  assert.equal(extractionSignal.aborted, true)
  complete.resolve(); await new Promise((r) => setImmediate(r))
  assert.equal(f.enriched.length, 0)
})
