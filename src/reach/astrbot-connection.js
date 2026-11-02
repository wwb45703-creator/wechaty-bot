import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import config from '../config-loader.js'
import { dataPath } from '../runtime-paths.js'

function file() { return dataPath('state', 'astrbot-connection.json') }
export function readAstrBotConnection() {
  let saved = {}
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('插件连接配置损坏，请检查 state/astrbot-connection.json') }
  const ac = config.astrbot ?? {}
  return { enabled: saved.enabled ?? ac.enabled ?? true,
    baseUrl: saved.baseUrl || ac.baseUrl || process.env.ASTRBOT_BASE_URL || 'http://127.0.0.1:6185',
    apiKey: Object.hasOwn(saved, 'apiKey') ? saved.apiKey : ac.apiKey || process.env.ASTRBOT_API_KEY || '',
    timeoutMs: ac.timeoutMs ?? 30000, passThroughCommands: ac.passThroughCommands ?? true }
}
export function publicAstrBotConnection() {
  const value = readAstrBotConnection()
  return { enabled: value.enabled, baseUrl: value.baseUrl, hasApiKey: Boolean(value.apiKey), apiKeyMasked: value.apiKey ? '••••••••' : '' }
}
export function saveAstrBotConnection(request = {}) {
  const current = readAstrBotConnection(), url = new URL(String(request.baseUrl || current.baseUrl).trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入有效的 HTTP 服务地址')
  // A local companion service must never send its credential to an arbitrary host.
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) throw new Error('插件服务仅支持本机 localhost / 127.0.0.1 / ::1')
  if (request.enabled !== undefined && typeof request.enabled !== 'boolean') throw new Error('启用状态必须为布尔值')
  if (request.apiKey !== undefined && (typeof request.apiKey !== 'string' || request.apiKey.length > 4096 || /[\r\n]/.test(request.apiKey))) throw new Error('API Key 格式无效')
  const value = { enabled: request.enabled ?? current.enabled, baseUrl: url.href.replace(/\/+$/, ''),
    apiKey: request.clearApiKey === true ? '' : request.apiKey?.trim() || current.apiKey }
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  const temporary = `${file()}.${randomUUID()}.tmp`
  try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, file()) }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) }
  return publicAstrBotConnection()
}
