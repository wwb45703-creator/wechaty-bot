import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-delivery-recovery-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
process.env.BOT_OFFLINE = '1'
const conf = { defaultPersona: 'A', personas: { A: '角色 A', B: '角色 B' },
  private: { enabled: true, cooldownSeconds: 0, dailyLimit: 10 }, ai: { replyDelaySeconds: [0, 0] } }
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify(conf))
const social = await import('../src/social/index.js')
const { createMessagingRuntime, conversationKey } = await import('../src/messaging.js')
const { createRateLimiter } = await import('../src/rate-limit.js')
const { createOutboxStore, purgePendingDeliveries } = await import('../src/outbox-store.js')
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

function fixture(accountId, commit = social.commitInteraction) {
  const dataRoot = fs.mkdtempSync(path.join(root, 'case-'))
  const scope = { platform: 'wechat', accountId, conversationId: 'private:user-a', personaId: 'A', subjectId: 'user-a' }
  const sends = []
  const options = { conf, dataRoot, socialApi: { ...social, commitInteraction: commit }, personaName: () => 'A', sleep: async () => {} }
  const runtime = createMessagingRuntime(options)
  const msg = (id, text = '谢谢你，代码问题解决了，私人原文不应落盘') => ({ id, self: () => false, text: () => text,
    wechaty: { currentUser: { id: accountId } }, talker: () => ({ id: 'user-a', name: () => '私人昵称', alias: async () => '', self: () => false }),
    say: async (value) => sends.push(value) })
  return { dataRoot, scope, sends, options, runtime, msg, file: path.join(dataRoot, 'state', 'message-outbox.json') }
}
function diskLedger(f) { return JSON.parse(fs.readFileSync(f.file, 'utf8')) }

test('confirmed delivery checkpoint survives failed journal commit without storing raw text or nickname', async () => {
  const f = fixture('checkpoint-failure', async () => { throw new Error('simulated journal outage') })
  const result = await f.runtime.process({ msg: f.msg('one'), producer: async () => '已确认的回复内容' })
  assert.equal(result.confirmedCount, 1)
  const raw = fs.readFileSync(f.file, 'utf8')
  assert.doesNotMatch(raw, /私人原文|私人昵称|已确认的回复内容|代码问题解决了/)
  const row = Object.values(diskLedger(f).messages)[0]
  assert.equal(row.socialPending.scope.personaId, 'A')
  assert.equal(row.socialPending.signals.sentiment, 'positive')
  assert.deepEqual(row.socialPending.signals.topics, ['编程技术'])
  assert.equal(social.getSocialState(f.scope).relationship.interactionCount, 0)
  f.runtime.dispose()
})

test('a fresh process replays only the confirmed social event and never resends the message', async () => {
  const f = fixture('process-restart', async () => { throw new Error('simulated crash window') })
  await f.runtime.process({ msg: f.msg('one'), producer: async () => '仅发送一次' })
  f.runtime.dispose()
  const script = `
    import fs from 'node:fs';
    import {createMessagingRuntime} from ${JSON.stringify(new URL('../src/messaging.js', import.meta.url).href)};
    import {getSocialState} from ${JSON.stringify(new URL('../src/social/index.js', import.meta.url).href)};
    const conf=JSON.parse(fs.readFileSync(process.env.BOT_CONFIG_FILE,'utf8'));
    const runtime=createMessagingRuntime({conf,dataRoot:${JSON.stringify(f.dataRoot)},personaName:()=> 'A'});
    const result=await runtime.ready();
    const second=await runtime.ready();
    console.log(JSON.stringify({result,second,count:getSocialState(${JSON.stringify(f.scope)}).relationship.interactionCount}));
    runtime.dispose();
  `
  const child = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: process.env, windowsHide: true }).trim())
  assert.equal(child.result.recovered, 1); assert.equal(child.second.recovered, 0); assert.equal(child.count, 1)
  assert.equal(Object.values(diskLedger(f).messages)[0].socialPending, undefined)
  const restored = createMessagingRuntime({ ...f.options, socialApi: social })
  const duplicate = await restored.process({ msg: f.msg('one'), producer: async () => assert.fail('delivery replayed') })
  assert.equal(duplicate.status, 'duplicate'); assert.deepEqual(f.sends, ['仅发送一次'])
  restored.dispose()
})

test('journal commit followed by lost acknowledgement remains exactly one interaction after replay', async () => {
  const f = fixture('committed-replay', async (event) => { await social.commitInteraction(event); throw new Error('commit ack lost') })
  await f.runtime.process({ msg: f.msg('one'), producer: async () => '一次回复' })
  assert.equal(social.getSocialState(f.scope).relationship.interactionCount, 1)
  f.runtime.dispose()
  const restored = createMessagingRuntime({ ...f.options, socialApi: social })
  assert.equal((await restored.ready()).recovered, 1)
  assert.equal(social.getSocialState(f.scope).relationship.interactionCount, 1)
  restored.dispose()
})

test('forget purges pending checkpoints for all roles and invalidates a stale on-disk recovery copy', async () => {
  const f = fixture('forget-checkpoints', async () => { throw new Error('journal unavailable') })
  await f.runtime.process({ msg: f.msg('role-a'), producer: async () => '回复 A' })
  const stale = diskLedger(f)
  await social.forgetSubject(f.scope)
  assert.equal(Object.values(diskLedger(f).messages)[0].socialPending, undefined)
  f.runtime.dispose()
  // A stale backup can still hold a checkpoint, but its epoch may never restore data.
  fs.writeFileSync(f.file, JSON.stringify(stale))
  const restored = createMessagingRuntime({ ...f.options, socialApi: social })
  const result = await restored.ready()
  assert.equal(result.discarded, 1); assert.equal(result.recovered, 0)
  assert.equal(social.getSocialState(f.scope).relationship.interactionCount, 0)
  restored.dispose()
})

test('all-conversation forget clears only that subject and account from pending delivery metadata', async () => {
  const f = fixture('all-checkpoints', async () => { throw new Error('journal unavailable') })
  await f.runtime.process({ msg: f.msg('one'), producer: async () => '回复' })
  const ledger = diskLedger(f), first = Object.values(ledger.messages)[0], checkpoint = first.socialPending
  ledger.messages.otherRole = { ...structuredClone(first), socialPending: { ...structuredClone(checkpoint), messageId: 'otherRole', scope: { ...f.scope, personaId: 'B', conversationId: 'room:r2' } } }
  ledger.messages.otherAccount = { ...structuredClone(first), socialPending: { ...structuredClone(checkpoint), messageId: 'otherAccount', scope: { ...f.scope, accountId: 'different-account' } } }
  f.runtime.dispose(); fs.writeFileSync(f.file, JSON.stringify(ledger))
  const restored = createMessagingRuntime({ ...f.options, socialApi: social })
  await social.forgetSubject(f.scope, { allConversations: true })
  const remaining = diskLedger(f).messages
  assert.equal(Object.values(remaining)[0].socialPending, undefined)
  assert.equal(remaining.otherRole.socialPending, undefined)
  assert.ok(remaining.otherAccount.socialPending)
  restored.dispose()
})

test('unknown sends and invalid checkpoints cannot grow social state', async () => {
  const f = fixture('unknown-recovery')
  const msg = f.msg('unconfirmed'); msg.say = async () => { throw new Error('native ack missing') }
  await f.runtime.process({ msg, producer: async () => '可能发出了但未知' })
  assert.equal(social.getSocialState(f.scope).relationship.interactionCount, 0)
  const ledger = diskLedger(f), [id, row] = Object.entries(ledger.messages)[0]
  row.socialPending = { version: 1, messageId: id, scope: f.scope, epoch: social.captureEpoch(f.scope), signals: { sentiment: 'positive', topics: ['编程技术'] } }
  f.runtime.dispose(); fs.writeFileSync(f.file, JSON.stringify(ledger))
  const restored = createMessagingRuntime({ ...f.options, socialApi: social })
  assert.equal((await restored.ready()).discarded, 1)
  assert.equal(social.getSocialState(f.scope).relationship.interactionCount, 0)
  restored.dispose()
})

test('recovery sanitizes signal enums and settles a crash reservation once', async () => {
  const f = fixture('reserved-recovery')
  f.runtime.dispose()
  const file = path.join(f.dataRoot, 'state', 'rate-limit.json')
  const rate = createRateLimiter({ file }), key = conversationKey(f.scope)
  const held = rate.reserve([{ key, dailyLimit: 10, cooldownSeconds: 0 }])
  const at = Date.now() - 1000
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, messages: { checkpoint: {
    status: 'sending', confirmedCount: 1, attemptedCount: 2, at, reservationId: held.id,
    socialPending: { version: 1, messageId: 'checkpoint', scope: f.scope, epoch: social.captureEpoch(f.scope), occurredAt: at,
      signals: { sentiment: 'privileged', topics: ['编程技术', '编程技术', 'PRIVATE_SECRET'], raw: 'PRIVATE_SECRET' } },
  } } }))
  const restored = createMessagingRuntime({ ...f.options, socialApi: social })
  assert.equal((await restored.ready()).recovered, 1)
  assert.equal((await restored.ready()).recovered, 0)
  const state = social.getSocialState(f.scope)
  assert.equal(state.relationship.interactionCount, 1); assert.equal(state.relationship.trust, 50)
  assert.deepEqual(state.persona.hobbies.map((h) => h.name), ['编程技术'])
  assert.equal(state.relationship.lastInteractedAt, new Date(at).toISOString())
  assert.deepEqual(Object.values(restored.limiter.snapshot().counts), [1])
  assert.deepEqual(restored.limiter.snapshot().holds, {})
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'state', 'social', 'journal.json'), 'utf8'), /PRIVATE_SECRET/)
  restored.dispose()
})

test('cross-process purge is immediate and stale bot saves cannot restore removed delivery attribution', async () => {
  const f = fixture('cross-process-delivery', async () => { throw new Error('journal unavailable') })
  await f.runtime.process({ msg: f.msg('one'), producer: async () => '已发送' })
  const source = new URL('../src/social/index.js', import.meta.url).href
  const storeSource = new URL('../src/outbox-store.js', import.meta.url).href
  const child = `
    const social=await import(${JSON.stringify(source)});
    const store=await import(${JSON.stringify(storeSource)});
    await social.forgetSubject(${JSON.stringify(f.scope)});
    store.purgePendingDeliveries(${JSON.stringify(f.scope)},{file:${JSON.stringify(f.file)}});
  `
  execFileSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', env: process.env, windowsHide: true })
  assert.ok(Object.values(diskLedger(f).messages).every(row => !row.socialPending))
  const unrelated = f.msg('unrelated', '新的普通消息')
  unrelated.talker = () => ({ id: 'another-user', name: () => '另一个人', alias: async () => '', self: () => false })
  await f.runtime.process({ msg: unrelated, producer: async () => '无关回复' })
  assert.ok(Object.values(diskLedger(f).messages).every(row => row.socialPending?.scope.subjectId !== f.scope.subjectId))
  assert.equal(social.getSocialState(f.scope).relationship.interactionCount, 0)
  f.runtime.dispose()
})

test('field-delta saves preserve another writer dedup records and deletions without relying on epoch changes', async () => {
  const f = fixture('merge-outbox-writers', async () => { throw new Error('journal unavailable') })
  await f.runtime.process({ msg: f.msg('old'), producer: async () => '旧回复' })
  const source = new URL('../src/outbox-store.js', import.meta.url).href
  await f.runtime.process({ msg: f.msg('next'), producer: async () => {
    const child = `
      const store=await import(${JSON.stringify(source)});
      const outbox=store.createOutboxStore({file:${JSON.stringify(f.file)}});
      outbox.claim('another-writer-dedup',{status:'confirmed',at:Date.now(),confirmedCount:1,kind:'text'});
      store.purgePendingDeliveries(${JSON.stringify(f.scope)},{file:${JSON.stringify(f.file)}});
    `
    execFileSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', env: process.env, windowsHide: true })
    return { text: '仅用于触发保存', learn: false }
  } })
  const ledger = diskLedger(f)
  assert.ok(ledger.messages['another-writer-dedup'])
  assert.ok(Object.values(ledger.messages).every(row => !row.socialPending))
  assert.equal(Object.keys(ledger.messages).length, 3)
  f.runtime.dispose()
})

test('multiple process writers retain all atomic claims; privacy cleanup keeps hashed dedup status', async () => {
  const f = fixture('parallel-outbox-writers')
  const source = new URL('../src/outbox-store.js', import.meta.url).href
  await Promise.all([0, 1, 2].map(writer => new Promise((resolve, reject) => {
    const script = `
      const {createOutboxStore}=await import(${JSON.stringify(source)});
      const store=createOutboxStore({file:${JSON.stringify(f.file)}});
      for(let i=0;i<12;i++) store.claim('writer-${writer}-'+i,{status:'confirmed',confirmedCount:1,at:Date.now(),kind:'text'});
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', data => { error += data })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(error || `writer exited ${code}`)))
  })))
  await f.runtime.process({ msg: f.msg('own'), producer: async () => ({ text: '自己的回复', learn: false }) })
  assert.equal(Object.keys(diskLedger(f).messages).length, 37)
  const store = createOutboxStore({ file: f.file })
  store.claim('retained-hash', { status: 'partial', confirmedCount: 1, at: Date.now(), kind: 'text', socialPending: {
    scope: f.scope, signals: { sentiment: 'positive', topics: ['编程技术'] }, epoch: social.captureEpoch(f.scope), messageId: 'retained-hash', version: 1,
  } })
  assert.equal(purgePendingDeliveries(f.scope, { file: f.file }).removed, 1)
  assert.deepEqual(diskLedger(f).messages['retained-hash'], { status: 'partial', confirmedCount: 1, at: diskLedger(f).messages['retained-hash'].at, kind: 'text' })
  f.runtime.dispose()
})

test('recovery releases orphan pre-send holds but conservatively charges referenced unknown sends', async () => {
  const f = fixture('orphan-reservations')
  f.runtime.dispose()
  const rateFile = path.join(f.dataRoot, 'state', 'rate-limit.json')
  const rate = createRateLimiter({ file: rateFile })
  const orphan = rate.reserve([{ key: 'orphan-before-outbox', dailyLimit: 10, cooldownSeconds: 0 }])
  const unknown = rate.reserve([{ key: 'referenced-native-send', dailyLimit: 10, cooldownSeconds: 0 }])
  createOutboxStore({ file: f.file }).claim('unknown-owner', { status: 'sending', at: Date.now(), confirmedCount: 0,
    attemptedCount: 1, reservationId: unknown.id, kind: 'text' })
  const restored = createMessagingRuntime({ ...f.options, socialApi: social })
  const result = await restored.ready()
  assert.equal(result.orphanReservationsReleased, 1)
  assert.equal((await restored.ready()).orphanReservationsReleased, 0)
  const state = restored.limiter.snapshot()
  assert.equal(state.holds[orphan.id], undefined); assert.equal(state.holds[unknown.id], undefined)
  assert.equal(state.cooldowns['orphan-before-outbox'], undefined)
  assert.deepEqual(Object.values(state.counts), [1])
  assert.equal(diskLedger(f).messages['unknown-owner'].status, 'unknown')
  assert.equal(social.getSocialState(f.scope).relationship.interactionCount, 0)
  restored.dispose()
})
