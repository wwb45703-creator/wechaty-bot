/**
 * 全局限流：每个会话的冷却时间 + 每日回复上限，防止刷屏与账号风险
 */

const cooldowns = new Map() // key -> 上次回复时间戳
const dailyCounts = new Map() // `date:key` -> 当日已回复条数

/** 返回东八区（Asia/Shanghai）当前日期字符串，格式 YYYY-MM-DD */
function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

// 每小时清理过期的 cooldowns 条目（避免长期运行后 Map 无限累积）
// 保守清理：删除超过 2 小时未活动的条目（最大冷却时间通常不超过 300s）
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  for (const [k, ts] of cooldowns.entries()) {
    if (ts < cutoff) cooldowns.delete(k)
  }
}, 60 * 60 * 1000).unref()

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
