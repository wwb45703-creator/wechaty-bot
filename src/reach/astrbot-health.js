/** Capability failures are latched by credential generation, not polled forever. */
export function createCapabilityMonitor({ now = Date.now, notify = () => {} } = {}) {
  let fingerprint = ''
  const records = new Map(), pending = new Map()
  return {
    async probe(name, operation, { identity, force = false, ttlMs = 60000 } = {}) {
      if (identity !== fingerprint) { fingerprint = identity; records.clear(); pending.clear() }
      const generation = fingerprint, previous = records.get(name)
      if (!force && previous && (previous.status === 'forbidden' || previous.status === 'unauthorized' || now() < previous.retryAt)) return previous
      if (pending.has(name)) return pending.get(name)
      const work = (async () => {
        let record
        try {
          const value = await operation()
          record = { status: 'ready', checkedAt: now(), retryAt: now() + ttlMs, value, failures: 0 }
        } catch (error) {
          const code = error.code || 'SERVICE_UNAVAILABLE'
          const status = code === 'PERMISSION_DENIED' ? 'forbidden' : code === 'AUTH_INVALID' ? 'unauthorized' : 'unavailable'
          const failures = (previous?.failures || 0) + 1
          record = { status, checkedAt: now(), retryAt: ['forbidden', 'unauthorized'].includes(status) ? Infinity : now() + Math.min(60000, 15000 * 2 ** Math.min(2, failures - 1)),
            error: error.message, code, httpStatus: error.httpStatus || null, requiredScope: error.requiredScope || null,
            retryable: error.retryable !== false, reachable: error.reachable === true, failures }
          if (generation === fingerprint && (previous?.code !== code || previous?.error !== error.message)) notify(name, record)
        }
        if (generation === fingerprint) records.set(name, record)
        return record
      })()
      pending.set(name, work)
      try { return await work } finally { if (pending.get(name) === work) pending.delete(name) }
    },
  }
}

export function publicCapability(record) {
  const { value, retryAt, failures, ...publicData } = record
  return { ...publicData, retryable: record.retryable ?? false }
}
