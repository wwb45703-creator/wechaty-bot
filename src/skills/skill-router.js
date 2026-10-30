import { getActiveSkillVersions } from './review-store.js'
import { compileSafeRegex } from './dsl-executor.js'

// Only immutable, content-addressed versions with a local human approval are
// routable. Source metadata (including a claimed approved flag) is never trusted.
let skills = []
export function reloadSkills() {
  skills = getActiveSkillVersions().map((v) => ({ ...v.content, hash: v.hash, triggers: v.content.triggers.map((t) => compileSafeRegex(typeof t === 'string' ? t : t.pattern, typeof t === 'string' ? 'i' : t.flags || 'i')), dsl: v.content.executionPlan ? v.content : null }))
  return skills.length
}
export function matchSkill(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  // UI and bot run in separate processes: refresh persisted approvals on lookup.
  reloadSkills()
  const found = skills.find((s) => s.triggers.some((r) => r.test(text.slice(0, 2048))))
  return found ? { ...found, triggers: undefined } : null
}
export function getSkillSOP(skillId) {
  reloadSkills()
  const found = skills.find((s) => s.id === skillId)
  return found ? `【已审核技能 - ${found.name}】\n${found.sop}` : ''
}
export function listEvolvedSkills() {
  reloadSkills()
  return skills.map(({ id, name, description, hash }) => ({ id, name, description, hash }))
}
