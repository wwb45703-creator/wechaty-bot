import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { dataPath } from './runtime-paths.js'

const clone = (value) => structuredClone(value)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const empty = () => ({ version: 1, messages: {} })
const pause = new Int32Array(new SharedArrayBuffer(4))

function readLedger(file) {
  try {
    const ledger = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (ledger.version !== 1 || !ledger.messages || Array.isArray(ledger.messages) || typeof ledger.messages !== 'object' ||
        Object.values(ledger.messages).some((row) => !row || Array.isArray(row) || typeof row !== 'object')) throw new Error('Invalid outbox state')
    return ledger
  } catch (error) {
    if (error.code === 'ENOENT') return empty()
    throw error
  }
}

function withLock(file, operation, timeoutMs) {
  const lock = file + '.lock'
  const owner = `${globalThis.process.pid}:${crypto.randomUUID()}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600)
      try { fs.writeFileSync(fd, owner, 'utf8') } finally { fs.closeSync(fd) }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let recorded
      try { recorded = fs.readFileSync(lock, 'utf8') } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError }
      const pid = Number(recorded.split(':')[0])
      let dead = false
      if (Number.isInteger(pid) && pid > 0) {
        try { globalThis.process.kill(pid, 0) } catch (probe) { dead = probe.code === 'ESRCH' }
      }
      if (dead) {
        try { if (fs.readFileSync(lock, 'utf8') === recorded) fs.unlinkSync(lock) } catch (removeError) { if (removeError.code !== 'ENOENT') throw removeError }
        continue
      }
      if (Date.now() - started >= timeoutMs) throw Object.assign(new Error('发件箱正在被其他进程写入，请稍后重试'), { code: 'OUTBOX_LOCKED' })
      Atomics.wait(pause, 0, 0, 10)
    }
  }
  try { return operation() } finally {
    try { if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function atomicWrite(file, ledger) {
  const temporary = `${file}.${globalThis.process.pid}.${crypto.randomUUID()}.tmp`
  let fd
  try {
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(ledger), 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(temporary, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

/** Both the bot and controller use this lock. A save merges only locally changed
 * fields into the latest disk view, so a stale bot cache cannot restore a purge. */
export function createOutboxStore({ file = dataPath('state', 'message-outbox.json'), isEpochCurrent, lockTimeoutMs = 3000 } = {}) {
  function transaction(operation) {
    return withLock(file, () => {
      const ledger = readLedger(file), before = JSON.stringify(ledger)
      const value = operation(ledger)
      if (isEpochCurrent) for (const row of Object.values(ledger.messages)) {
        if (row.socialPending && !isEpochCurrent(row.socialPending.scope, row.socialPending.epoch)) delete row.socialPending
      }
      if (before !== JSON.stringify(ledger)) atomicWrite(file, ledger)
      return { ledger: clone(ledger), value }
    }, lockTimeoutMs)
  }
  return {
    file,
    read() { return withLock(file, () => clone(readLedger(file)), lockTimeoutMs) },
    transaction,
    claim(id, row) {
      return transaction((ledger) => {
        if (Object.hasOwn(ledger.messages, id)) return false
        ledger.messages[id] = clone(row)
        return true
      })
    },
    merge(local, baseline) {
      return transaction((ledger) => {
        for (const [id, row] of Object.entries(local.messages)) {
          const previous = baseline.messages[id]
          if (!previous) {
            if (!Object.hasOwn(ledger.messages, id)) ledger.messages[id] = clone(row)
            continue
          }
          if (!Object.hasOwn(ledger.messages, id)) {
            if (!equal(previous, row)) ledger.messages[id] = clone(row)
            continue
          }
          const current = ledger.messages[id]
          for (const key of new Set([...Object.keys(previous), ...Object.keys(row)])) {
            if (equal(row[key], previous[key]) && Object.hasOwn(row, key) === Object.hasOwn(previous, key)) continue
            if (Object.hasOwn(row, key)) current[key] = clone(row[key])
            else delete current[key]
          }
        }
        for (const id of Object.keys(baseline.messages)) {
          if (!Object.hasOwn(local.messages, id) && equal(ledger.messages[id], baseline.messages[id])) delete ledger.messages[id]
        }
      }).ledger
    },
  }
}

/** Privacy cleanup is independent of the social module to avoid import cycles. */
export function purgePendingDeliveries(scope, { allConversations = false, dataRoot, file } = {}) {
  if (!scope?.platform || !scope?.accountId || !scope?.subjectId || (!allConversations && !scope?.conversationId)) throw new Error('遗忘发件箱必须提供完整作用域')
  const store = createOutboxStore({ file: file || (dataRoot ? path.join(dataRoot, 'state', 'message-outbox.json') : undefined) })
  const { value } = store.transaction((ledger) => {
    let removed = 0
    for (const row of Object.values(ledger.messages)) {
      const target = row.socialPending?.scope
      if (target && target.platform === scope.platform && target.accountId === scope.accountId && target.subjectId === scope.subjectId &&
          (allConversations || target.conversationId === scope.conversationId)) { delete row.socialPending; removed++ }
    }
    return removed
  })
  return { removed: value }
}
