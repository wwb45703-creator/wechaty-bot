import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataPath } from './runtime-paths.js'

const dayAt = (now) => new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })

/** Atomic process-local reservations; persisted holds count after a restart. */
export function createRateLimiter({ file = null, now = Date.now } = {}) {
  let state = { version: 1, counts: {}, cooldowns: {}, holds: {} }
  if (file && fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (loaded.version !== 1 || !loaded.counts || !loaded.holds) throw new Error('Invalid rate-limit state')
    state = loaded
  }
  function save() {
    if (!file) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8')
    fs.renameSync(tmp, file)
  }
  function check(key, cooldownSeconds = 0, dailyLimit = 0) {
    const stamp = now(), day = dayAt(stamp)
    const last = state.cooldowns[key]?.time
    const remaining = last == null ? 0 : Number(cooldownSeconds) - (stamp - last) / 1000
    if (remaining > 0) return { allowed: false, reason: 'cooldown', remainingSeconds: Math.ceil(remaining) }
    const pending = Object.values(state.holds).filter((h) => h.day === day && h.limits.some((l) => l.key === key)).length
    if (dailyLimit > 0 && (state.counts[`${day}:${key}`] || 0) + pending >= dailyLimit) return { allowed: false, reason: 'dailyLimit' }
    return { allowed: true }
  }
  function reserve(limits) {
    const unique = [...new Map(limits.map((l) => [l.key, l])).values()]
    for (const l of unique) {
      const verdict = check(l.key, l.cooldownSeconds, l.dailyLimit)
      if (!verdict.allowed) return verdict
    }
    const id = crypto.randomUUID(), stamp = now(), day = dayAt(stamp)
    state.holds[id] = { day, limits: unique }
    for (const l of unique) state.cooldowns[l.key] = { time: stamp, reservation: id }
    for (const [key, h] of Object.entries(state.holds)) if (h.day !== day) delete state.holds[key]
    for (const key of Object.keys(state.counts)) if (!key.startsWith(day + ':')) delete state.counts[key]
    save()
    return { allowed: true, id }
  }
  function settle(id, consume) {
    const hold = state.holds[id]
    if (!hold) return
    if (consume) for (const l of hold.limits) state.counts[`${hold.day}:${l.key}`] = (state.counts[`${hold.day}:${l.key}`] || 0) + 1
    else for (const l of hold.limits) if (state.cooldowns[l.key]?.reservation === id) delete state.cooldowns[l.key]
    delete state.holds[id]
    save()
  }
  return { check, reserve, settle, snapshot: () => structuredClone(state) }
}

let defaultLimiter
function limiter() { return defaultLimiter ||= createRateLimiter({ file: dataPath('state', 'rate-limit.json') }) }
export function reserveRate(limits) { return limiter().reserve(limits) }
export function settleRate(id, consume) { return limiter().settle(id, consume) }
export function checkRate(key, cooldownSeconds, dailyLimit) { return limiter().check(key, cooldownSeconds, dailyLimit) }
export function recordReply(key, dailyLimit) {
  const held = limiter().reserve([{ key, dailyLimit, cooldownSeconds: 0 }])
  if (held.allowed) limiter().settle(held.id, true)
}
