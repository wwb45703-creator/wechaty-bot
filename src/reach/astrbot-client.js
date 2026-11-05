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

import { logger } from '../logger.js'
import { validateExternalUrl } from '../url-utils.js'
import { readAstrBotConnection } from './astrbot-connection.js'
import { createHash } from 'node:crypto'
import { createCapabilityMonitor, publicCapability } from './astrbot-health.js'


/** 获取 AstrBot 配置 */
export function getAstrBotConfig() {
  const value = readAstrBotConnection()
  return { ...value, baseUrl: value.baseUrl.replace(/\/+$/, '') }
}

function assertEnabled(cfg) { if (!cfg.enabled) throw Object.assign(new Error('AstrBot 桥接未启用，请在插件中心启用连接'), { code: 'DISABLED', retryable: false }) }
function pluginExtractUrl(message) {
  const command = /^\/?(?:anysearch|搜索|websearch)\s+([\s\S]+)$/i.exec(String(message || '').trim())?.[1]
  if (!command) return null
  return /^(?:extract|网页|提取|网页提取)\s+([\s\S]+)$/i.exec(command)?.[1] || (/^https?:\/\//i.test(command) ? command : null)
}
function presentPluginReply(message, reply) {
  if (!pluginExtractUrl(message)) return reply
  try {
    const page = JSON.parse(reply)
    if (typeof page?.url === 'string' && /^https?:\/\//i.test(page.url) && typeof page.content === 'string') {
      return [typeof page.title === 'string' ? page.title : '', page.content, `来源：${page.url}`].filter(Boolean).join('\n\n')
    }
  } catch { /* Other plugin reply formats remain plain text. */ }
  return reply
}
function scopeFor(endpoint) { return endpoint.startsWith('/knowledge-bases') ? 'kb' : endpoint.startsWith('/chat') ? 'chat' : 'plugin' }
function apiError(res, data, endpoint) {
  const requiredScope = scopeFor(endpoint)
  let message = String(data?.message || data?.detail || `AstrBot HTTP ${res.status} / 响应格式无效`).slice(0, 500)
  if (res.status === 401) message = 'AstrBot 认证失败（401）：API Key 无效或已失效'
  if (res.status === 403) message = `AstrBot 权限不足（403）：缺少 ${requiredScope} 权限，请在管理界面创建已授权的专用 Key`
  const secret = getAstrBotConfig().apiKey
  if (secret) message = message.split(secret).join('[已隐藏]')
  return Object.assign(new Error(message), { code: res.status === 401 ? 'AUTH_INVALID' : res.status === 403 ? 'PERMISSION_DENIED' : !data ? 'INVALID_RESPONSE' : res.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'API_ERROR',
    httpStatus: res.status, requiredScope, reachable: true, retryable: res.status >= 500 })
}
const identity = () => createHash('sha256').update(JSON.stringify(getAstrBotConfig())).digest('hex')
const monitor = createCapabilityMonitor({ notify(name, state) { logger.warn(`[AstrBot] ${name === 'knowledge' ? '知识库' : '插件'}状态：${state.error}`) } })
const failure = error => ({ ok: false, error: error.message || error.error, code: error.code || 'SERVICE_UNAVAILABLE', httpStatus: error.httpStatus || null,
  requiredScope: error.requiredScope || null, retryable: error.retryable !== false })
async function requestJson(endpoint, { method = 'GET', body, timeoutMs, signal } = {}) {
  const cfg = getAstrBotConfig(); assertEnabled(cfg)
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs || cfg.timeoutMs || 10000)
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1${endpoint}`, { method, headers: {
      Authorization: `ApiKey ${cfg.apiKey}`, 'Accept-Language': 'zh-CN', ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal })
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.status !== 'ok') throw apiError(res, data, endpoint)
    return data
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('AstrBot 请求超时，请检查插件服务'), { code: 'TIMEOUT', retryable: true })
    if (!error.code) Object.assign(error, { code: 'SERVICE_UNAVAILABLE', retryable: true })
    throw error
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}

/** 探活检测：AstrBot 服务端是否健康在线 */
export async function isAstrBotAlive(timeoutMs = 1500, { signal } = {}) {
  const cfg = getAstrBotConfig()
  if (!cfg.enabled) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()

  try {
    const res = await fetch(`${cfg.baseUrl}/api/v1/plugins`, {
      method: 'GET',
      headers: {
        Authorization: `ApiKey ${cfg.apiKey}`,
      },
      signal: controller.signal,
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => null)
    return data?.status === 'ok' && Array.isArray(data.data)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
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
export async function chatWithAstrBot({ message, sessionId = 'default', username = 'user', timeoutMs, signal }) {
  const cfg = getAstrBotConfig()
  if (!cfg.enabled) {
    return { ok: false, error: 'AstrBot 桥接未启用' }
  }

  const effectiveTimeout = timeoutMs || cfg.timeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), effectiveTimeout)
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()

  try {
    const extractUrl = pluginExtractUrl(message)
    if (extractUrl) {
      const valid = await validateExternalUrl(extractUrl, { signal: controller.signal })
      if (!valid.ok) return failure(Object.assign(new Error(`SSRF 防护拦截：${valid.error}`), { code: valid.code, retryable: false }))
    }
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
      return failure(apiError(res, await res.json().catch(() => null), '/chat'))
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
        } else if (payload.type === 'plain' && !payload.chain_type && typeof payload.data === 'string') {
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

    return { ok: true, reply: presentPluginReply(message, finalReply) }
  } catch (err) {
    const isAbort = err.name === 'AbortError'
    if (!signal?.aborted) logger.warn(`[AstrBot] 请求异常: ${isAbort ? '响应超时' : '服务不可达'}`)
    return failure(Object.assign(new Error(signal?.aborted ? 'AstrBot 请求已取消' : isAbort ? 'AstrBot 响应超时' : 'AstrBot 服务不可达'),
      { code: signal?.aborted ? 'CANCELLED' : isAbort ? 'TIMEOUT' : 'SERVICE_UNAVAILABLE', retryable: !signal?.aborted }))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/** 查询 AstrBot 当前已安装插件 */
export async function listInstalledPlugins(options = {}) {
  const data = await requestJson('/plugins', options)
  if (!Array.isArray(data.data)) throw new Error('AstrBot 插件列表格式不正确')
  return data.data
}

/** 检索 AstrBot 官方插件市场 (2800+ 插件) */
export async function searchMarketPlugins(keyword = '', limit = 10) {
    const data = await requestJson('/plugins/market')
    if (!data.data || typeof data.data !== 'object') throw new Error('AstrBot 市场响应格式不正确')

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
}

/** 安装 GitHub / Git 插件 */
export async function installPlugin(repoUrl) {
  if (!getAstrBotConfig().enabled) return { status: 'error', ok: false, message: 'AstrBot 桥接未启用' }
  const cleanUrl = String(repoUrl || '').trim()
  if (!cleanUrl) {
    return { status: 'error', message: '插件仓库地址不能为空' }
  }

  const valid = await validateExternalUrl(cleanUrl)
  if (!valid.ok) {
    return { status: 'error', message: `SSRF 防护拦截：${valid.error}` }
  }

  try {
    const data = await requestJson('/plugins/install/github', { method: 'POST', body: { url: cleanUrl }, timeoutMs: 120000 })
    return { ...data, ok: true }
  } catch (e) {
    logger.error(`[AstrBot] 安装插件异常: ${e.message}`)
    return { ...failure(e), status: 'error', message: e.message }
  }
}

/** 切换插件启用/禁用状态 */
export async function togglePlugin({ name, enabled }) {
  const cleanName = String(name || '').trim()
  if (!cleanName) {
    return { ok: false, error: '插件名称不能为空' }
  }

  try {
    if (typeof enabled !== 'boolean') throw new Error('插件启用状态必须为布尔值')
    const data = await requestJson(`/plugins/${encodeURIComponent(cleanName)}/enabled`, { method: 'PATCH', body: { enabled } })
    return { ok: true, data: data.data }
  } catch (e) {
    logger.error(`[AstrBot] 切换插件状态异常: ${e.message}`)
    return failure(e)
  }
}

/** 查询知识库列表 */
export async function listKnowledgeBases({ force = true } = {}) {
  const state = await monitor.probe('knowledge', async () => {
    const data = await requestJson('/knowledge-bases')
    if (!Array.isArray(data.data?.items)) throw new Error('AstrBot 知识库列表格式不正确')
    return data.data.items.map(item => ({ ...item, id: item.kb_id || item.id, name: item.kb_name || item.name, documents_count: item.doc_count ?? item.documents_count ?? 0, chunks_count: item.chunk_count ?? item.chunks_count ?? 0 }))
  }, { identity: identity(), force })
  return state.status === 'ready' ? { ok: true, data: state.value, capability: publicCapability(state) } : { ...failure(state), data: [], capability: publicCapability(state) }
}

/** 在指定知识库中检索知识切片 */
export async function queryKnowledgeBase({ kbId, kbName, query, topK = 3 }) {
  const cleanKbId = String(kbId || '').trim()
  if (!cleanKbId) {
    return { ok: false, error: '知识库 ID 不能为空' }
  }
  const cleanTopK = Math.max(1, Math.min(20, parseInt(topK, 10) || 3))
  if (!String(query || '').trim()) return { ok: false, error: '检索问题不能为空' }

  try {
    let selectedName = String(kbName || '').trim()
    if (!selectedName) {
      const bases = await listKnowledgeBases()
      if (!bases.ok) return bases
      selectedName = bases.data.find(item => item.id === cleanKbId)?.name || cleanKbId
    }
    const data = await requestJson(`/knowledge-bases/${encodeURIComponent(cleanKbId)}/retrieve`, { method: 'POST', body: {
      query: String(query).trim().slice(0, 1000), top_k: cleanTopK, kb_names: [selectedName]
    } })
    const chunks = Array.isArray(data.data) ? data.data : data.data?.results
    if (!Array.isArray(chunks)) throw new Error('AstrBot 检索结果格式不正确')
    return { ok: true, chunks }
  } catch (e) {
    logger.warn(`[AstrBot] 检索知识库失败: ${e.message}`)
    return failure(e)
  }
}

/** 获取 AstrBot 全局运行状态与统计 */
export async function getAstrBotStatus({ force = false } = {}) {
  const cfg = getAstrBotConfig()
  const state = await monitor.probe('plugins', async () => {
    const plugins = (await requestJson('/plugins', { timeoutMs: 2000 })).data
    if (!Array.isArray(plugins)) throw new Error('插件列表格式不正确')
    return plugins
  }, { identity: identity(), force, ttlMs: 15000 })
  if (state.status !== 'ready') {
    return {
      alive: false,
      baseUrl: cfg.baseUrl,
      enabled: cfg.enabled,
      error: state.error,
      code: state.code,
      reachable: state.reachable === true,
      capabilities: { plugins: publicCapability(state), knowledge: { status: 'unknown' }, chat: { status: 'unknown' } },
      pluginCount: null,
      kbCount: null,
    }
  }

  const plugins = state.value
  const kbs = await listKnowledgeBases({ force })

  return {
    alive: true,
    reachable: true,
    baseUrl: cfg.baseUrl,
    enabled: cfg.enabled,
    pluginCount: plugins.length,
    plugins: plugins.map((p) => ({
      name: p.name,
      displayName: p.i18n?.['zh-CN']?.metadata?.display_name || p.display_name || p.name,
      desc: p.i18n?.['zh-CN']?.metadata?.desc || p.desc || '',
      author: p.author || '',
      version: p.version || '',
      activated: p.activated !== false,
      reserved: Boolean(p.reserved),
    })),
    kbCount: kbs.ok ? kbs.data.length : null,
    knowledgeBases: kbs.data || [],
    knowledgeError: kbs.error,
    capabilities: { plugins: publicCapability(state), knowledge: kbs.capability, chat: { status: 'unknown' } },
  }
}

export async function uninstallPlugin({ name, confirmed } = {}) {
  try {
    if (confirmed !== true) throw new Error('请先确认卸载插件')
    if (typeof name !== 'string' || !name.trim()) throw new Error('插件名称不能为空')
    const data = await requestJson(`/plugins/${encodeURIComponent(name.trim())}`, { method: 'DELETE' })
    return { ok: true, data: data.data }
  } catch (error) { return failure(error) }
}
