import { validateExternalUrl, fetchPageText } from '../url-utils.js'
import { webSearch } from '../reach/search.js'

const ACTIONS = Object.freeze({ safe_fetch: true, regex_extract: true, template_render: true, reach_search: true })
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const LIMITS = { steps: 8, text: 12000, pattern: 256, deadline: 15000 }
const PARAM_KEYS = { safe_fetch: ['url', 'timeoutMs'], regex_extract: ['pattern', 'source', 'flags'], template_render: ['template'], reach_search: ['query', 'maxResults'] }

// Small regex dialect. No lookaround, backreferences, counted or group
// repetition. At most two quantifier marks in total, only one unbounded. This
// intentionally also counts escaped/class marks conservatively: rejected rules
// need a simpler trigger rather than a synchronously expensive backtracking regex.
export function compileSafeRegex(pattern, flags = 'i') {
  if (typeof pattern !== 'string' || !pattern || pattern.length > LIMITS.pattern) throw new Error('正则长度无效')
  if (typeof flags !== 'string' || !/^(?:i?u?|u?i?)$/.test(flags)) throw new Error('仅允许 i/u 正则标记')
  if (/\(\?|\\[1-9]|\\[kg]|[{}]|\)[+*?]|(?:[+*?]){2}/.test(pattern)) throw new Error('拒绝危险正则结构')
  // Concatenated ambiguous alternations can be exponential even without quantifiers.
  if ((pattern.replace(/\\./g, '').match(/\(/g) || []).length > 2) throw new Error('正则最多允许两个捕获分组')
  if ((pattern.match(/[+*?]/g) || []).length > 2) throw new Error('正则最多允许两个量词，避免可选分支回溯')
  if ((pattern.match(/[+*]/g) || []).length > 1 || /\.[+*]/.test(pattern)) throw new Error('拒绝不受限的正则重复')
  return new RegExp(pattern, flags)
}

export function renderTemplate(template, context = {}) {
  if (typeof template !== 'string') return ''
  return template.replace(/\{\{(\$[1-9][0-9]?|[a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    if (UNSAFE_KEYS.has(key) || !Object.hasOwn(context, key)) return ''
    const val = context[key]
    return ['string', 'number', 'boolean'].includes(typeof val) ? String(val) : ''
  })
}

function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
export function validateSkillDefinition(dsl) {
  if (!plain(dsl) || !plain(dsl.executionPlan)) return { ok: false, error: '无效的 DSL 技能配置' }
  const pipeline = dsl.executionPlan.pipeline
  if (!Array.isArray(pipeline) || pipeline.length < 1 || pipeline.length > LIMITS.steps) return { ok: false, error: '流水线必须包含 1～8 步' }
  try {
    if (JSON.stringify(dsl).length > 32000) throw new Error('技能配置过大')
    for (const step of pipeline) {
      if (!plain(step) || !Object.hasOwn(ACTIONS, step.action)) throw new Error(`拒绝执行未注册动作: ${String(step?.action)}`)
      if (Object.keys(step).some((k) => !['action', 'params', 'exportAs', 'ignoreError'].includes(k))) throw new Error('动作包含未声明字段')
      if (step.params !== undefined && !plain(step.params)) throw new Error('动作参数必须是对象')
      if (step.exportAs && (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(step.exportAs) || UNSAFE_KEYS.has(step.exportAs))) throw new Error('无效的导出变量')
      if (step.ignoreError !== undefined && typeof step.ignoreError !== 'boolean') throw new Error('ignoreError 必须是布尔值')
      for (const [key, value] of Object.entries(step.params || {})) {
        if (!PARAM_KEYS[step.action].includes(key) || UNSAFE_KEYS.has(key) || !['string', 'number', 'boolean'].includes(typeof value) || String(value).length > LIMITS.text) throw new Error('参数类型或长度无效')
      }
      if (step.action === 'regex_extract') compileSafeRegex(step.params?.pattern, step.params?.flags || '')
      if (step.action === 'template_render' && typeof step.params?.template !== 'string') throw new Error('模板不能为空')
      if (step.action === 'safe_fetch' && typeof step.params?.url !== 'string') throw new Error('URL 模板不能为空')
      if (step.action === 'reach_search' && step.params?.maxResults !== undefined && (!Number.isInteger(step.params.maxResults) || step.params.maxResults < 1 || step.params.maxResults > 5)) throw new Error('搜索结果数量必须为 1～5')
    }
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
}

async function runAction(step, ctx, services, signal, deadline) {
  const p = step.params || {}
  if (step.action === 'regex_extract') {
    const match = compileSafeRegex(p.pattern, p.flags || '').exec(renderTemplate(p.source || '{{input}}', ctx).slice(0, 2048))
    if (!match) return { ok: false, error: '未匹配到内容' }
    return { ok: true, data: Object.fromEntries(match.slice(1).map((value, i) => [`$${i + 1}`, value || ''])) }
  }
  if (step.action === 'template_render') return { ok: true, data: { result: renderTemplate(p.template, ctx) } }
  if (step.action === 'safe_fetch') {
    const check = await services.validateExternalUrl(renderTemplate(p.url, ctx), { signal, deadline })
    if (signal.aborted || Date.now() >= deadline) return { ok: false, error: '已取消', fatal: true }
    if (!check.ok) return { ok: false, error: `SSRF 防御拦截: ${check.error || '地址不允许'}`, fatal: true }
    const page = await services.fetchPageText(check.url, { signal, deadline, timeoutMs: Math.max(1, deadline - Date.now()) })
    if (!page?.ok) return { ok: false, error: page?.error || '抓取失败', fatal: Boolean(page?.fatal) }
    return { ok: true, data: { title: page.title || '', description: page.description || '', text: String(page.summary || page.text || '').slice(0, LIMITS.text) } }
  }
  const query = renderTemplate(p.query || '{{input}}', ctx).trim()
  if (!query) return { ok: false, error: '搜索词为空' }
  const result = await services.webSearch(query, { maxResults: p.maxResults || 3, signal, deadline })
  if (result?.ok === false) return { ok: false, error: result.error || '搜索失败', fatal: Boolean(result.fatal) }
  return { ok: true, data: { results: result?.results || [], total: result?.results?.length || 0 } }
}

export async function executeSkillPipeline(dsl, initialContext = {}, options = {}) {
  const valid = validateSkillDefinition(dsl)
  if (!valid.ok) return valid
  const ctx = Object.create(null)
  for (const [key, value] of Object.entries(initialContext)) if (!UNSAFE_KEYS.has(key) && typeof value === 'string') ctx[key] = value.slice(0, LIMITS.text)
  const timeoutMs = Math.max(1, Math.min(LIMITS.deadline, Number(options.timeoutMs) || LIMITS.deadline))
  const deadline = Math.min(Date.now() + timeoutMs, Number(options.deadline) || Infinity)
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) return { ok: false, error: '技能执行已取消' }
  options.signal?.addEventListener('abort', abort, { once: true })
  const services = options.services || { validateExternalUrl, fetchPageText, webSearch }
  let timer
  const stopped = new Promise((resolve) => {
    controller.signal.addEventListener('abort', () => resolve({ ok: false, error: '技能执行已取消或超时', fatal: true }), { once: true })
    timer = setTimeout(abort, Math.max(1, deadline - Date.now()))
  })
  try {
    for (let i = 0; i < dsl.executionPlan.pipeline.length; i++) {
      if (controller.signal.aborted || Date.now() >= deadline) return { ok: false, error: '技能执行已取消或超时' }
      const step = dsl.executionPlan.pipeline[i]
      const result = await Promise.race([runAction(step, ctx, services, controller.signal, deadline).catch((err) => ({ ok: false, error: err.message })), stopped])
      if (!result.ok) {
        if (step.ignoreError && !result.fatal && !controller.signal.aborted) continue
        return { ok: false, error: `步骤 ${step.action} 失败: ${result.error}`, stepIndex: i }
      }
      Object.assign(ctx, result.data)
      if (step.exportAs) ctx[step.exportAs] = result.data
    }
    return { ok: true, context: ctx }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
