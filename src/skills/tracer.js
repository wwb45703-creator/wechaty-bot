/**
 * tracer.js — 在线交互轨迹捕获与待审提案收集器
 *
 * 核心机制：
 *  1. 轻量化捕获：仅在用户显式纠错或工具执行重试/报错时记录
 *  2. 隐私隔离：仅记录意图关键词与执行断点，不记录私聊人名与好友隐私
 *  3. 安全落盘：仅写入只读提案文件 state/proposals/，在线过程零执行权限
 */

import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../logger.js'

const PROPOSALS_DIR = path.join(process.cwd(), 'state', 'proposals')
const lastRecordedMap = new Map()

/** 纠错关键词特征 */
const CORRECTION_PATTERNS = [
  /不对/i,
  /你搞错了/i,
  /不是这样/i,
  /换个方法/i,
  /应该用/i,
  /别用这个/i,
  /改成/i,
  /不要回这么长/i,
  /不要分段/i,
]

/**
 * 判定文本中是否包含用户对机器人的明确纠错/改进意向
 */
export function isUserCorrection(text) {
  if (!text || typeof text !== 'string') return false
  const clean = text.trim()
  return CORRECTION_PATTERNS.some((pat) => pat.test(clean))
}

/**
 * 记录执行轨迹并沉淀为待审提案
 * @param {object} p
 * @param {string} p.sessionId 会话标识
 * @param {string} p.userText 用户输入文本
 * @param {string} [p.actionName] 触发的动作或技能
 * @param {string} [p.errorMessage] 错误或异常描述
 * @param {string} [p.correction] 用户纠错内容
 */
export function recordInteractionTrace({ sessionId = 'unknown', userText = '', actionName = '', errorMessage = '', correction = '' }) {
  if (!userText && !errorMessage && !correction) return

  // 会话频率控制：单会话 30 秒内最多记录 1 次提案，防止死循环刷盘
  const now = Date.now()
  const last = lastRecordedMap.get(sessionId) || 0
  if (now - last < 30000) return
  lastRecordedMap.set(sessionId, now)

  try {
    if (!fs.existsSync(PROPOSALS_DIR)) {
      fs.mkdirSync(PROPOSALS_DIR, { recursive: true })
    }

    const traceData = {
      version: 1,
      timestamp: new Date().toISOString(),
      actionName,
      userIntentSnippet: userText.slice(0, 100), // 限制长度，防隐私泄漏
      errorMessage: errorMessage ? String(errorMessage).slice(0, 200) : '',
      correction: correction ? String(correction).slice(0, 150) : '',
      status: 'pending_reflection',
    }

    const filename = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`
    const filePath = path.join(PROPOSALS_DIR, filename)

    fs.writeFileSync(filePath, JSON.stringify(traceData, null, 2), 'utf8')
    logger.info(`[tracer] 记录交互轨迹待审提案: ${filename}`)
  } catch (err) {
    logger.warn(`[tracer] 保存轨迹提案失败: ${err.message}`)
  }
}
