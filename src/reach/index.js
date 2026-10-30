import config from '../config-loader.js'
import { fetchPageText, validateExternalUrl } from '../url-utils.js'
import { platformFetch } from './platforms.js'
import { fetchViaJina } from './jina.js'

export const NETWORK_CAPABILITIES = Object.freeze({
  native: true, platformApi: true, jina: 'explicit-opt-in',
  scrapling: false, browser: false, agentReach: false,
  reason: 'Optional external executors are disabled until they enforce the same DNS, redirect, body and cancellation policy.',
})

export function createRichFetcher({ validate = validateExternalUrl, platform = platformFetch,
  reader = fetchPageText, jina = fetchViaJina } = {}) {
  return async function fetchRich(urlStr, options = {}) {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (options.signal?.aborted) cancel()
    options.signal?.addEventListener('abort', cancel, { once: true })
    const deadline = Math.min(options.deadline || Infinity, Date.now() + Math.min(45000, options.totalTimeoutMs || 45000))
    const timer = setTimeout(cancel, Math.max(1, deadline - Date.now()))
    const attempts = []
    const opts = () => ({ ...options, signal: controller.signal, deadline,
      timeoutMs: Math.max(1, Math.min(options.timeoutMs || 20000, deadline - Date.now())) })
    try {
      const checked = await validate(urlStr, { signal: controller.signal })
      if (!checked.ok) return { ...checked, fatal: true, attempts }
      if (config.reach?.enabled !== false) {
        const result = await platform(urlStr, opts())
        if (result?.fatal || result?.ok) return result
        attempts.push('platform: no result')
      }
      const page = await reader(urlStr, opts())
      if (page.fatal || controller.signal.aborted) return { ...page, attempts }
      if (page.ok && String(page.summary || '').length >= 120) return { ...page, source: 'native' }
      if (config.reach?.enabled !== false && config.reach?.jina?.enabled === true && Date.now() < deadline) {
        const fallback = await jina(urlStr, opts())
        if (fallback?.fatal || fallback?.ok) return fallback
        attempts.push('jina: no result')
      }
      return { ...page, source: page.ok ? 'native-thin' : undefined, attempts }
    } catch (error) {
      return { ok: false, error: controller.signal.aborted ? '抓取已取消或超时' : '抓取失败', fatal: Boolean(error.fatal), code: error.code, attempts }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', cancel)
    }
  }
}
export const fetchRich = createRichFetcher()
