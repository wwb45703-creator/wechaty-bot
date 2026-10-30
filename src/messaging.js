import path from 'node:path'
import crypto from 'node:crypto'
import config from './config-loader.js'
import { dataPath } from './runtime-paths.js'
import { createRateLimiter } from './rate-limit.js'
import { splitBubbles, cleanBubbleText, stripAtMentions } from './utils.js'
import { getActivePersonaName } from './persona-commands.js'
import { createOutboxStore, purgePendingDeliveries } from './outbox-store.js'
import * as social from './social/index.js'

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex')
export const conversationKey = (scope) => JSON.stringify([scope.platform, scope.accountId, scope.conversationId])
export const chatKeyFor = (scope) => JSON.stringify([scope.platform, scope.accountId, scope.conversationId, scope.personaId])
export function accountIdFor(bot) { return bot?.currentUser?.id || bot?.userSelf?.()?.id || 'local' }
export function waitForDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) return resolve()
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** ID-bearing room entries never match another room merely because its name is equal. */
export function roomConfigFor(conf, topic, roomId) {
  const rooms = Array.isArray(conf?.rooms) ? conf.rooms : []
  const exact = rooms.find((r) => r?.id && r.id === roomId)
  if (exact) return exact
  const named = rooms.filter((r) => !r?.id && r?.topic && r.topic === topic)
  return named.length === 1 ? named[0] : undefined
}

export async function admitMessage(msg, room, conf = config, socialApi = social) {
  if (conf?.enabled === false || conf?.bot?.enabled === false || msg.self?.() || msg.talker?.()?.self?.()) return null
  const talker = msg.talker(), name = talker.name?.() || '', id = talker.id
  if (!id) return null
  const accountId = accountIdFor(msg.wechaty || room?.wechaty)
  const scope = { platform: 'wechat', accountId, conversationId: room ? `room:${room.id}` : `private:${id}`, personaId: 'default', subjectId: id }
  // Capture before alias/topic/mention lookups can yield to a privacy command.
  const epoch = socialApi.captureEpoch(scope)
  const topic = room ? await room.topic().catch(() => '') : ''
  const rc = room ? roomConfigFor(conf, topic, room.id) : null
  if (room && (!rc || rc.enabled === false || conf?.room?.enabled === false)) return null
  if (!room && conf?.private?.enabled === false) return null
  const alias = room ? '' : (await talker.alias?.()?.catch(() => '') || '')
  if (!room) {
    const ids = conf?.private?.whitelistIds || []
    const list = conf?.private?.whitelist || []
    if (ids.length && !ids.includes(id)) return null
    if (!ids.length && list.length && !list.some((entry) => {
      if (entry && typeof entry === 'object') return entry.id ? entry.id === id : entry.name === name || entry.alias === alias
      return entry === id || entry === name || (alias && entry === alias)
    })) return null
  }
  return { msg, room, rc, topic, talker, name: alias || name, selfName: msg.wechaty?.currentUser?.name?.() || '', scope, epoch }
}

/** A single queue/outbox owns every outbound text, including media replies and cron. */
export function createMessagingRuntime({ conf = config, dataRoot = null, socialApi = social,
  personaName = getActivePersonaName, rate = null, sleep = waitForDelay,
  afterForget = async () => {}, onConfirmed = async () => {}, extract = async () => [], now = Date.now } = {}) {
  const root = dataRoot || dataPath('')
  const file = path.join(root, 'state', 'message-outbox.json')
  const limiter = rate || createRateLimiter({ file: path.join(root, 'state', 'rate-limit.json'), now })
  const outbox = createOutboxStore({ file, isEpochCurrent: (scope, epoch) => socialApi.isEpochCurrent(scope, epoch) })
  let ledger = outbox.read()
  let persistedLedger = structuredClone(ledger)
  const queues = new Map(), active = new Map(), inProgress = new Set()
  const restoredIds = new Set(Object.keys(ledger.messages))
  let recoveryJob = null
  function abortScope(scope, { allConversations = false } = {}) {
    const key = conversationKey(scope)
    for (const [target, controllers] of active) if (target === key ||
      (allConversations && JSON.parse(target)[0] === scope.platform && JSON.parse(target)[1] === scope.accountId)) {
      for (const controller of controllers) controller.abort()
    }
  }
  function forgetDelivery(scope, options = {}) {
    abortScope(scope, options)
    purgePendingDeliveries(scope, { ...options, file })
    synchronize(outbox.read())
  }
  const unregisterForget = socialApi.registerForgetHook?.(forgetDelivery)
  function releaseController(key, ctrl) {
    active.get(key)?.delete(ctrl)
    if (!active.get(key)?.size) active.delete(key)
  }
  async function wait(ms, signal) {
    if (signal.aborted || ms <= 0) return
    let abort
    const cancelled = new Promise((resolve) => { abort = resolve; signal.addEventListener('abort', abort, { once: true }) })
    try { await Promise.race([sleep(ms, signal), cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
  }
  function firstDelay() {
    const range = conf.ai?.replyDelaySeconds
    const lo = Math.max(0, Number(Array.isArray(range) ? range[0] : range?.min) || 0)
    const hi = Math.max(lo, Number(Array.isArray(range) ? range[1] : range?.max) || lo)
    return (lo + Math.random() * (hi - lo)) * 1000
  }
  function synchronize(latest) {
    // Keep row object identities: active async jobs hold references to these rows.
    for (const id of Object.keys(ledger.messages)) if (!Object.hasOwn(latest.messages, id)) delete ledger.messages[id]
    for (const [id, row] of Object.entries(latest.messages)) {
      const target = ledger.messages[id] || (ledger.messages[id] = {})
      for (const key of Object.keys(target)) if (!Object.hasOwn(row, key)) delete target[key]
      Object.assign(target, structuredClone(row))
    }
    persistedLedger = structuredClone(latest)
  }
  function save() {
    synchronize(outbox.merge(ledger, persistedLedger))
  }
  function tokenCurrent(scope, epoch) { return socialApi.isEpochCurrent(scope, epoch) }
  function checkpointFor(scope, epoch, messageId, userText) {
    return { version: 1, scope: { platform: scope.platform, accountId: scope.accountId,
      conversationId: scope.conversationId, personaId: scope.personaId, subjectId: scope.subjectId },
    epoch: structuredClone(epoch), messageId,
    signals: social.sanitizeInteractionSignals(social.summarizeInteractionSignals(userText)), occurredAt: now() }
  }
  async function reconcile() {
    synchronize(outbox.read())
    const result = { recovered: 0, discarded: 0, failed: 0, orphanReservationsReleased: 0 }
    const referenced = new Set(Object.values(ledger.messages).map((row) => row.reservationId).filter(Boolean))
    for (const id of Object.keys(limiter.snapshot().holds)) if (!referenced.has(id)) {
      // reserve() is persisted just before its outbox owner. Without that owner,
      // this process could not have reached the native sending call.
      limiter.settle(id, false)
      result.orphanReservationsReleased++
    }
    for (const [id, row] of Object.entries(ledger.messages)) {
      if (inProgress.has(id) || (!restoredIds.has(id) && !row.socialPending)) continue
      const pending = row.socialPending
      let changed = false
      if (pending) {
        const fields = ['platform', 'accountId', 'conversationId', 'personaId', 'subjectId']
        const valid = pending.version === 1 && pending.messageId === id && pending.scope &&
          fields.every((key) => typeof pending.scope[key] === 'string' && pending.scope[key].length > 0) &&
          Number.isInteger(row.confirmedCount) && row.confirmedCount > 0 && row.confirmedCount <= 3
        if (!valid || !tokenCurrent(pending.scope, pending.epoch)) {
          delete row.socialPending
          result.discarded++; changed = true
        } else {
          try {
            const eventId = await socialApi.commitInteraction({ scope: pending.scope, messageId: id,
              signals: social.sanitizeInteractionSignals(pending.signals), occurredAt: pending.occurredAt,
              sendOutcome: { confirmedCount: row.confirmedCount, failed: row.status !== 'confirmed' }, epoch: pending.epoch })
            // A concurrent forget hook can remove the checkpoint while an async adapter resolves.
            if (row.socialPending?.messageId === pending.messageId && tokenCurrent(pending.scope, pending.epoch) && eventId) {
              delete row.socialPending
              result.recovered++; changed = true
            }
          } catch { result.failed++ }
        }
      }
      // A restored reservation is settled from durable transport evidence. Unknown native
      // sends consume quota conservatively, but they never become confirmed social events.
      if (restoredIds.has(id)) {
        if (row.reservationId) {
          limiter.settle(row.reservationId, row.confirmedCount > 0 || row.attemptedCount > 0 || row.unknown === true)
          delete row.reservationId; changed = true
        }
        if (['queued', 'generating', 'sending'].includes(row.status)) {
          row.status = row.confirmedCount > 0 ? 'partial' : row.attemptedCount > 0 ? 'unknown' : 'interrupted'
          row.unknown = row.attemptedCount > row.confirmedCount
          changed = true
        }
        restoredIds.delete(id)
      }
      if (changed) save()
    }
    return result
  }
  function recoverPending() {
    if (recoveryJob) return recoveryJob
    recoveryJob = reconcile().finally(() => { recoveryJob = null })
    return recoveryJob
  }
  function limitsFor(a, kind) {
    const base = conversationKey(a.scope), room = Boolean(a.room)
    const limits = [{ key: base, cooldownSeconds: room ? a.rc?.cooldownSeconds ?? 10 : conf.private?.cooldownSeconds ?? 30,
      dailyLimit: room ? conf.roomDailyLimit ?? 500 : conf.private?.dailyLimit ?? 200 }]
    const special = ({ search: conf.reach?.search, link: conf.links, image: conf.vision, emoticon: conf.emoticon })[kind]
    if (special) limits.push({ key: `${base}:${kind}`, cooldownSeconds: special.cooldownSeconds ?? 0, dailyLimit: special.dailyLimit ?? 0 })
    return limits
  }
  async function process({ msg, room = null, kind = 'text', producer, admission = null, forget = false, allConversations = false }) {
    const feature = ({ search: conf.reach?.search, link: conf.links, image: conf.vision, emoticon: conf.emoticon,
      welcome: conf.welcome, cron: conf.scheduler })[kind]
    if (feature?.enabled === false || (kind === 'search' && conf.reach?.enabled === false)) return { status: 'disabled', confirmedCount: 0 }
    const a = admission || await admitMessage(msg, room, conf, socialApi)
    if (!a) return { status: 'denied', confirmedCount: 0 }
    const rawId = msg.id
    if (!rawId) return { status: 'missing-message-id', confirmedCount: 0 }
    const queueKey = conversationKey(a.scope)
    const id = digest(queueKey + ':' + rawId)
    synchronize(outbox.read())
    if (ledger.messages[id]) {
      await recoverPending()
      return { status: 'duplicate', confirmedCount: ledger.messages[id].confirmedCount || 0 }
    }
    // Persist admission before any model call or send. A crash never silently replays work.
    const claimed = outbox.claim(id, { status: 'queued', at: now(), confirmedCount: 0, kind })
    synchronize(claimed.ledger)
    if (!claimed.value) {
      await recoverPending()
      return { status: 'duplicate', confirmedCount: ledger.messages[id].confirmedCount || 0 }
    }
    const cutoff = now() - 30 * 86400000
    for (const [k, row] of Object.entries(ledger.messages)) if (row.at < cutoff && !row.socialPending && !row.reservationId && ['confirmed', 'failed', 'stale', 'limited', 'denied', 'interrupted'].includes(row.status)) delete ledger.messages[k]
    save()
    if (forget) {
      await socialApi.forgetSubject(a.scope, { allConversations })
      forgetDelivery(a.scope, { allConversations })
      await afterForget(a.scope, { allConversations })
    }
    await recoverPending()
    const epoch = forget ? socialApi.captureEpoch(a.scope) : a.epoch ?? socialApi.captureEpoch(a.scope)
    const prev = queues.get(queueKey) || Promise.resolve()
    const job = prev.catch(() => {}).then(async () => {
      const row = ledger.messages[id]
      if (!(await admitMessage(msg, room, conf, socialApi))) { row.status = 'denied'; save(); return { status: 'denied', confirmedCount: 0 } }
      if (!tokenCurrent(a.scope, epoch)) { row.status = 'stale'; save(); return { status: 'stale', confirmedCount: 0 } }
      const role = personaName(a.scope)
      const scope = { ...a.scope, personaId: role || 'default' }
      const held = forget ? { allowed: true, id: null } : limiter.reserve(limitsFor(a, kind))
      if (!held.allowed) { row.status = 'limited'; row.reason = held.reason; save(); return { status: 'limited', confirmedCount: 0 } }
      if (held.id) row.reservationId = held.id
      inProgress.add(id)
      const ctrl = new AbortController()
      if (!active.has(queueKey)) active.set(queueKey, new Set())
      active.get(queueKey).add(ctrl)
      let outcome = { status: 'failed', confirmedCount: 0, attemptedCount: 0, unknown: false }
      let eventCommitted = false
      let extractionPending = false
      try {
        row.status = 'generating'; save()
        const result = await producer({ ...a, scope, epoch, signal: ctrl.signal, key: chatKeyFor(scope), messageId: id })
        if (!tokenCurrent(scope, epoch) || ctrl.signal.aborted) { outcome.status = 'stale'; return outcome }
        const packet = typeof result === 'string' ? { text: result } : result || {}
        const bubbles = packet.bubbles || splitBubbles(packet.text || '')
        const sent = []
        await wait(firstDelay(), ctrl.signal)
        for (let i = 0; i < bubbles.length; i++) {
          if (!tokenCurrent(scope, epoch) || ctrl.signal.aborted) { outcome.status = outcome.confirmedCount ? 'partial' : 'stale'; break }
          const text = cleanBubbleText(room ? stripAtMentions(bubbles[i], [a.name, a.selfName].filter(Boolean)) : bubbles[i])
          if (!text) continue
          row.status = 'sending'; row.attemptedCount = ++outcome.attemptedCount; save()
          try {
            const shouldAt = room && i === 0 && (packet.mention ?? a.shouldAt ?? false)
            if (room) await room.say(shouldAt ? `@${a.name} ${text}` : text, ...(shouldAt ? [a.talker] : []))
            else await msg.say(text)
            outcome.confirmedCount++; sent.push(text)
            row.confirmedCount = outcome.confirmedCount; row.status = 'partial'
            if (packet.learn !== false && tokenCurrent(scope, epoch) && !ctrl.signal.aborted) {
              row.socialPending ||= checkpointFor(scope, epoch, id, packet.userText ?? msg.text?.() ?? '')
            }
            save()
            if (!tokenCurrent(scope, epoch) || ctrl.signal.aborted) { outcome.status = 'stale'; break }
          } catch (err) {
            // Transport rejection can occur after the native send; preserve ambiguity, never replay.
            outcome.unknown = true; outcome.status = outcome.confirmedCount ? 'partial' : 'unknown'
            row.errorCode = String(err?.code || 'send-unconfirmed').slice(0, 80)
            break
          }
          if (i < bubbles.length - 1) {
            await wait(400 + Math.random() * 300, ctrl.signal)
          }
        }
        if (outcome.status !== 'stale' && outcome.confirmedCount === bubbles.filter(Boolean).length && outcome.confirmedCount) outcome.status = 'confirmed'
        if (outcome.confirmedCount && tokenCurrent(scope, epoch) && packet.historyKey) {
          await onConfirmed({ key: packet.historyKey, scope, reply: sent.join(' ||| ') })
        }
        if (outcome.confirmedCount && packet.learn !== false && tokenCurrent(scope, epoch)) {
          if (packet.preference) socialApi.recordPreference?.(scope, packet.preference, epoch)
          const eventId = await socialApi.commitInteraction({ scope, messageId: id, userText: packet.userText ?? msg.text?.() ?? '',
            personaName: role, displayName: a.name, sendOutcome: { ...outcome, failed: outcome.status !== 'confirmed', sentTexts: sent },
            occurredAt: row.socialPending?.occurredAt, epoch })
          eventCommitted = Boolean(eventId)
          if (eventId) delete row.socialPending
          if (eventId && packet.extract !== false) {
            const userText = packet.userText ?? msg.text?.() ?? ''
            extractionPending = true
            // Extraction sees user statements only; assistant output is never a fact source.
            Promise.resolve().then(() => tokenCurrent(scope, epoch) ? extract({ userText, scope, epoch, signal: ctrl.signal }) : []).then((facts) =>
              tokenCurrent(scope, epoch) ? socialApi.enrichInteraction({ scope, eventId, facts, epoch, userText }) : false).catch(() => {}).finally(() => releaseController(queueKey, ctrl))
          }
        }
        return outcome
      } catch (err) {
        outcome.status = outcome.confirmedCount ? 'partial' : ctrl.signal.aborted || !tokenCurrent(scope, epoch) ? 'stale' : 'failed'
        row.errorCode = String(err?.code || 'generation-failed').slice(0, 80)
        return outcome
      } finally {
        if (!eventCommitted && outcome.confirmedCount === 0 && tokenCurrent(scope, epoch)) {
          try { await socialApi.commitInteraction({ scope, messageId: id, userText: '', displayName: a.name,
            sendOutcome: { ...outcome, failed: true }, epoch }) } catch {}
        }
        row.status = outcome.status; row.confirmedCount = outcome.confirmedCount; row.unknown = outcome.unknown; save()
        if (held.id) { limiter.settle(held.id, outcome.confirmedCount > 0 || outcome.unknown); delete row.reservationId; save() }
        inProgress.delete(id)
        if (!extractionPending) releaseController(queueKey, ctrl)
      }
    })
    const queued = job.catch(() => {})
    queues.set(queueKey, queued)
    job.finally(() => { if (queues.get(queueKey) === queued) queues.delete(queueKey) }).catch(() => {})
    return job
  }
  return { process, ready: recoverPending, recoverPending, admit: (msg, room) => admitMessage(msg, room, conf, socialApi), snapshot: () => structuredClone(ledger), limiter,
    dispose() {
      unregisterForget?.()
      for (const controllers of active.values()) for (const controller of controllers) controller.abort()
    } }
}

let runtime
export function getMessagingRuntime() {
  return runtime ||= createMessagingRuntime({ afterForget: async (scope, options) => {
    const ai = await import('./ai.js')
    ai.resetConversationScope?.(scope, options)
  }, onConfirmed: async (args) => (await import('./ai.js')).confirmConversationReply(args),
    extract: async (args) => (await import('./ai.js')).extractFacts(args) })
}
export function processMessage(options) { return getMessagingRuntime().process(options) }
