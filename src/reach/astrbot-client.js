/**
 * AstrBot 本地服务桥接客户端
 *
 * 连接本地轻量部署的 AstrBot Agent 框架 (http://127.0.0.1:6185)，
 * 将其庞大的插件生态 (2800+ 社区插件)、技能工具及多 Agent 工作流能力无缝接入到现有的 Wechaty 微信机器人中。
 *
 * 核心设计原则：
 *  1. 零微信风控：微信消息协议收发完全由本地 WeChat XP 真机底层处理，AstrBot 仅作为无头计算后端。
 *  2. 智能指令分流：对斜杠命令 (/help, /reset, /sid, 插件指令) 或工具调用自动转发 AstrBot 执行。
 *  3. 安全降级容错：AstrBot 未启动或响应超时时平滑降级，绝不影响原本的微信闲聊与记忆功能。
 */

import config from '../config-loader.js'
import { logger } from '../logger.js'

const DEFAULT_BASE_URL = 'http://127.0.0.1:6185'
const DEFAULT_API_KEY = 'abk_0qS1Oyco8juZQe-3DwrNxVQQFVrByUL5jkFD-j5ABjI'

/** 获取 AstrBot 配置 */
export function getAstrBotConfig() {
  const ac = config.astrbot ?? {}
  return {
    enabled: ac.enabled ?? true,
    baseUrl: (ac.baseUrl || process.env.ASTRBOT_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    apiKey: ac.apiKey || process.env.ASTRBOT_API_KEY || DEFAULT_API_KEY,
    timeoutMs: ac.timeoutMs ?? 30000,
    passThroughCommands: ac.passThroughCommands ?? true,
  }
}

/** 探活检测：AstrBot 服务端是否健康在线 */
export async function isAstrBotAlive(timeoutMs = 1500) {
  const cfg = getAstrBotConfig()
  if (!cfg.enabled) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/plugins`, {
      method: 'GET',
      headers: {
        Authorization: `ApiKey ${cfg.apiKey}`,
      },
      signal: controller.signal,
    })
    return res.status === 200
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** 判断消息是否属于 AstrBot 指令（以 / 开头，或插件显式命令） */
export function isAstrBotCommand(text) {
  if (!text || typeof text !== 'string') return false
  const t = text.trim()
  if (t.startsWith('/')) return true
  // 插件管理辅助命令
  if (/^(astrbot|插件)\s*(帮助|列表|状态|market)/i.test(t)) return true
  return false
}

/**
 * 调用 AstrBot Chat API 处理对话与插件指令
 * @param {object} params
 * @param {string} params.message 用户文本消息
 * @param {string} [params.sessionId] 会话标识（如群 ID 或好友 ID）
 * @param {string} [params.username] 用户名或昵称
 * @param {number} [params.timeoutMs] 超时时间毫秒
 * @returns {Promise<{ ok: boolean, reply?: string, error?: string }>}
 */
export async function chatWithAstrBot({ message, sessionId = 'default', username = 'user', timeoutMs }) {
  const cfg = getAstrBotConfig()
  if (!cfg.enabled) {
    return { ok: false, error: 'AstrBot 桥接未启用' }
  }

  const effectiveTimeout = timeoutMs || cfg.timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), effectiveTimeout)

  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        message,
        session_id: String(sessionId),
        username: String(username),
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return { ok: false, error: `AstrBot HTTP ${res.status}: ${errText}` }
    }

    // 解析 SSE 流
    const text = await res.text()
    const lines = text.split('\n')
    let accumulatedPlain = ''
    let completeReply = ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue

      try {
        const payload = JSON.parse(raw)
        if (payload.type === 'complete' && typeof payload.data === 'string') {
          completeReply = payload.data
        } else if (payload.type === 'plain' && typeof payload.data === 'string') {
          accumulatedPlain += payload.data
        }
      } catch {
        // 忽略非 JSON 数据行
      }
    }

    const finalReply = (completeReply || accumulatedPlain).trim()
    if (!finalReply) {
      return { ok: false, error: 'AstrBot 未返回有效文本' }
    }

    return { ok: true, reply: finalReply }
  } catch (err) {
    const isAbort = err.name === 'AbortError'
    logger.warn(`[AstrBot] 请求异常: ${isAbort ? '响应超时' : err.message}`)
    return { ok: false, error: isAbort ? 'AstrBot 响应超时' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

/** 查询 AstrBot 当前已安装插件 */
export async function listInstalledPlugins() {
  const cfg = getAstrBotConfig()
  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/plugins`, {
      headers: { Authorization: `ApiKey ${cfg.apiKey}` },
    })
    const data = await res.json()
    if (data.status === 'ok' && Array.isArray(data.data)) {
      return data.data
    }
    return []
  } catch (e) {
    logger.warn(`[AstrBot] 查询已安装插件失败: ${e.message}`)
    return []
  }
}

/** 检索 AstrBot 官方插件市场 (2800+ 插件) */
export async function searchMarketPlugins(keyword = '', limit = 10) {
  const cfg = getAstrBotConfig()
  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/plugins/market`, {
      headers: { Authorization: `ApiKey ${cfg.apiKey}` },
    })
    const data = await res.json()
    if (data.status !== 'ok' || !data.data) return []

    const results = []
    const kw = keyword.toLowerCase().trim()

    for (const [key, item] of Object.entries(data.data)) {
      if (key === '$meta' || typeof item !== 'object') continue
      const name = item.name || key
      const desc = item.desc || ''
      const author = item.author || ''

      if (!kw || name.toLowerCase().includes(kw) || desc.toLowerCase().includes(kw) || author.toLowerCase().includes(kw)) {
        results.push({
          id: key,
          name,
          desc,
          author,
          version: item.version || '',
          repo: item.repo || '',
        })
        if (results.length >= limit) break
      }
    }
    return results
  } catch (e) {
    logger.warn(`[AstrBot] 检索插件市场失败: ${e.message}`)
    return []
  }
}

/** 安装 GitHub / Git 插件 */
export async function installPlugin(repoUrl) {
  const cfg = getAstrBotConfig()
  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/plugins/install/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `ApiKey ${cfg.apiKey}`,
      },
      body: JSON.stringify({ url: repoUrl }),
    })
    return await res.json()
  } catch (e) {
    logger.error(`[AstrBot] 安装插件异常: ${e.message}`)
    return { status: 'error', message: e.message }
  }
}
