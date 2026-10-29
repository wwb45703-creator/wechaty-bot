/**
 * skill-router.js — 渐进式技能加载与 L0 索引路由器
 *
 * 核心机制：
 *  1. L0 极简常驻索引：内存占用 < 20KB，零 Token 消耗
 *  2. 毫秒级正则与意图匹配，未命中时不干扰普通聊天
 *  3. L1 SOP 动态装载：仅在命中时才读取对应 SKILL.md SOP 注入 systemExtra
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logger } from '../logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const EVOLVED_DIR = path.join(__dirname, 'evolved')

/** L0 技能常驻索引表 */
const skillIndex = new Map()

/**
 * 加载或刷新已沉淀的正式技能索引
 */
export function reloadSkills() {
  skillIndex.clear()
  if (!fs.existsSync(EVOLVED_DIR)) {
    try {
      fs.mkdirSync(EVOLVED_DIR, { recursive: true })
    } catch {
      // 容错
    }
    return
  }

  const entries = fs.readdirSync(EVOLVED_DIR, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillId = entry.name
    const metaPath = path.join(EVOLVED_DIR, skillId, 'meta.json')
    const skillMdPath = path.join(EVOLVED_DIR, skillId, 'SKILL.md')

    if (!fs.existsSync(metaPath)) continue

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      let sop = ''
      if (fs.existsSync(skillMdPath)) {
        const fullMd = fs.readFileSync(skillMdPath, 'utf8')
        // 提取 SOP 部分或简短操作指南
        const sopMatch = fullMd.match(/## SOP[^\n]*\n([\s\S]*?)(?=\n##|$)/i)
        sop = sopMatch ? sopMatch[1].trim() : fullMd.slice(0, 300).trim()
      }

      // 预编译触发正则
      const compiledTriggers = (meta.triggers || []).map((t) => {
        if (typeof t === 'string') {
          return new RegExp(t, 'i')
        }
        if (t && t.pattern) {
          return new RegExp(t.pattern, t.flags || 'i')
        }
        return null
      }).filter(Boolean)

      skillIndex.set(skillId, {
        id: skillId,
        name: meta.name || skillId,
        description: meta.description || '',
        triggers: compiledTriggers,
        sop,
        dsl: meta.executionPlan ? meta : null,
        confidence: meta.confidence ?? 0.8,
        author: meta.author || 'system',
      })
    } catch (err) {
      logger.warn(`[skill-router] 加载技能 ${skillId} 失败: ${err.message}`)
    }
  }

  logger.info(`[skill-router] 成功加载 ${skillIndex.size} 个 L0 演化技能`)
}

/**
 * 意图匹配：毫秒级扫描用户消息是否命中某个沉淀技能
 * @param {string} text 用户输入的聊天文本
 * @returns {object|null} 命中的技能元数据，未命中返回 null
 */
export function matchSkill(text) {
  if (!text || typeof text !== 'string') return null
  const clean = text.trim()
  if (!clean) return null

  // 延迟初始加载
  if (skillIndex.size === 0) {
    reloadSkills()
  }

  for (const [skillId, skill] of skillIndex.entries()) {
    for (const reg of skill.triggers) {
      if (reg.test(clean)) {
        return {
          id: skillId,
          name: skill.name,
          description: skill.description,
          sop: skill.sop,
          dsl: skill.dsl,
          confidence: skill.confidence,
        }
      }
    }
  }

  return null
}

/**
 * 获取技能 SOP 用于注入会话的 systemExtra
 */
export function getSkillSOP(skillId) {
  const skill = skillIndex.get(skillId)
  if (!skill) return ''
  return `【演进技能指导 - ${skill.name}】\n${skill.sop}`
}

/**
 * 获取当前所有已生效技能列表
 */
export function listEvolvedSkills() {
  if (skillIndex.size === 0) reloadSkills()
  return Array.from(skillIndex.values()).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    confidence: s.confidence,
  }))
}

// 模块载入时初次扫描
try {
  reloadSkills()
} catch {
  // 静默容错
}
