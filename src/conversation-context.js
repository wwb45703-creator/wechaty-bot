import { isEpochCurrent } from './social/index.js'
/** Short-lived group context, never persisted or shared across accounts/conversations. */
export function createConversationContext({ now = Date.now } = {}) {
  const groups = new Map()
  const key = scope => JSON.stringify([scope?.platform, scope?.accountId, scope?.conversationId])
  const fresh = scope => (groups.get(key(scope)) || []).filter(row => now() - row.at < 600000 &&
    (row.epoch === undefined || isEpochCurrent(row.scope, row.epoch)))
  return {
    observe(scope, text, { messageId = '', name = '', epoch } = {}) {
      if (!scope?.accountId || !scope.conversationId?.startsWith('room:')) return
      const content = String(text || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 200)
      if (!content || content.startsWith('<')) return
      const rows = fresh(scope).filter(row => !messageId || row.messageId !== messageId)
      rows.push({ scope: { ...scope }, text: content, name, messageId, epoch, at: now() })
      groups.delete(key(scope)); groups.set(key(scope), rows.slice(-12))
      while (groups.size > 200) groups.delete(groups.keys().next().value)
    },
    read(scope, { excludeId = '' } = {}) { return structuredClone(fresh(scope).filter(row => !excludeId || row.messageId !== excludeId)) },
    forget(scope, { allConversations = false } = {}) {
      for (const [group, rows] of groups) {
        groups.set(group, rows.filter(row => !(row.scope.platform === scope.platform && row.scope.accountId === scope.accountId &&
          row.scope.subjectId === scope.subjectId && (allConversations || row.scope.conversationId === scope.conversationId))))
      }
    },
  }
}
export const recentContext = createConversationContext()
