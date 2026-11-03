/** Recipient policy is evaluated before work and immediately before native delivery. */
export function recipientAllowed(conf = {}, roomId = '', kind = 'text') {
  const policy = conf.replyPolicy || {}
  if (policy.allowAutonomous === false && ['cron', 'welcome'].includes(kind)) return false
  if (!roomId) return policy.allowPrivate !== false && conf.private?.enabled !== false
  if (policy.strictRoomIds !== true) return true
  if (Array.isArray(policy.allowedRoomIds) && !policy.allowedRoomIds.includes(roomId)) return false
  return (conf.rooms || []).some(room => room?.enabled !== false && room?.id === roomId)
}

export function explicitCommand(text, conf = {}) {
  const t = String(text || '').trim().replace(/^\//, '')
  if (/^(?:知识库|插件|astrbot)(?:\s|$)/i.test(t)) return true
  if (/^(?:帮我搜索一下|帮我搜一下|帮我搜|搜索一下|搜一下|搜索)\s*\S/.test(t)) return true
  if (/^(?:我的记忆|忘记我(?:全部会话|所有会话)?|人设列表|角色列表|性格状态|人格状态|心理状态|恢复默认|恢复人设|查看群指令|群指令|查看群约定|群约定|群要求|重置群指令|清除群指令|清空群指令|清空群约定|查群ID|群ID|查群|群信息)$/.test(t)) return true
  if (/^(?:变成.{1,40}|切换人设[:：\s]*.{1,40})$/.test(t)) return true
  return Boolean((conf.dingDong && t.toLowerCase() === 'ding') || (conf.menu?.enabled && t === conf.menu.keyword))
}

export function directedTextReason(text, { names = [], wakeWords = ['小助手'], conf = {} } = {}) {
  const t = String(text || '').trim().normalize('NFKC')
  // A quoted/forwarded mention or somebody merely talking about the bot is not a summons.
  const leading = t.match(/^(?:@[^\s@]+[\s\u2005]*)+/u)?.[0] || ''
  const tokens = leading.match(/@[^\s@]+/gu) || []
  const known = new Set(names.filter(Boolean).map(name => '@' + String(name).normalize('NFKC')))
  if (tokens.some(token => known.has(token.replace(/[,:：，]+$/, '')))) return 'mention'
  const wake = wakeWords.find(word => word && t.startsWith(String(word).normalize('NFKC')))
  if (wake) return `wake:${wake}`
  if (explicitCommand(t, conf)) return 'command'
  return ''
}
