/**
 * 全局限流：每个会话的冷却时间 + 每日回复上限，防止刷屏与账号风险
 */

const cooldowns = new Map() // key -> 上次回复时间戳
const dailyCounts = new Map() // `date:key` -> 当日已回复条数

function today() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * @param {string} key        会话 key
 * @param {number} cooldownSeconds 冷却秒数
 * @param {number} dailyLimit 每日上限（0 或负数表示不限制）
 * @returns {{allowed: boolean, reason?: string, remainingSeconds?: number}}
 */
export function checkRate(key, cooldownSeconds, dailyLimit) {
  const now = Date.now()
  const last = cooldowns.get(key) || 0
  const elapsed = (now - last) / 1000
  if (elapsed < cooldownSeconds) {
    return { allowed: false, reason: 'cooldown', remainingSeconds: Math.ceil(cooldownSeconds - elapsed) }
  }
  if (dailyLimit > 0) {
    const dayKey = `${today()}:${key}`
    const used = dailyCounts.get(dayKey) || 0
    if (used >= dailyLimit) {
      return { allowed: false, reason: 'dailyLimit' }
    }
  }
  return { allowed: true }
}

export function recordReply(key, dailyLimit) {
  cooldowns.set(key, Date.now())
  if (dailyLimit > 0) {
    const dayKey = `${today()}:${key}`
    dailyCounts.set(dayKey, (dailyCounts.get(dayKey) || 0) + 1)
  }
  // 顺手清理过期的日计数，防止内存缓慢增长
  if (dailyCounts.size > 2000) {
    const t = today()
    for (const k of dailyCounts.keys()) {
      if (!k.startsWith(t)) dailyCounts.delete(k)
    }
  }
}
