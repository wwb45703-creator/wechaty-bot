/**
 * dsl-executor.js — 声明式 DSL 技能安全执行引擎
 *
 * 铁律：
 *  1. 绝对严禁 eval / Function / vm 执行动态代码
 *  2. 仅支持预设的原子静态 Action，所有网络请求强制经 validateExternalUrl SSRF 校验
 *  3. 参数插值使用安全字符串替换 {{key}}，不执行任何表达式
 */

import { validateExternalUrl, fetchPageText } from '../url-utils.js'
import { webSearch } from '../reach/search.js'
import { logger } from '../logger.js'

/**
 * 纯字符串模板插值：仅支持 {{key}} 简单变量替换，无任何代码执行风险
 */
export function renderTemplate(template, context = {}) {
  if (typeof template !== 'string') return ''
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const val = context[key]
    return val !== undefined && val !== null ? String(val) : ''
  })
}

/**
 * 允许调用的静态原子动作映射表
 */
const ATOMIC_ACTIONS = {
  /**
   * 安全页面抓取（受 SSRF 和 400KB 限流保护）
   */
  async safe_fetch(params, ctx) {
    const rawUrl = renderTemplate(params?.url || '', ctx)
    if (!rawUrl) return { ok: false, error: 'URL 为空' }

    const check = await validateExternalUrl(rawUrl)
    if (!check.ok) {
      return { ok: false, error: `SSRF 防御拦截: ${check.reason}` }
    }

    try {
      const page = await fetchPageText(check.cleanUrl, { timeoutMs: params?.timeoutMs || 8000 })
      return {
        ok: true,
        data: {
          title: page.title || '',
          description: page.description || '',
          text: (page.text || '').slice(0, 1000), // 限制上下文长度
        },
      }
    } catch (err) {
      return { ok: false, error: `抓取失败: ${err.message}` }
    }
  },

  /**
   * 正则变量提取
   */
  async regex_extract(params, ctx) {
    const pattern = params?.pattern
    const sourceText = renderTemplate(params?.source || '{{input}}', ctx)
    if (!pattern || typeof sourceText !== 'string') {
      return { ok: false, error: '缺少 pattern 或 source' }
    }

    try {
      const reg = new RegExp(pattern, params?.flags || '')
      const match = sourceText.match(reg)
      if (!match) return { ok: false, error: '未匹配到内容' }

      const extracted = {}
      for (let i = 1; i < match.length; i++) {
        extracted[`$${i}`] = match[i]
      }
      return { ok: true, data: extracted }
    } catch (err) {
      return { ok: false, error: `正则语法异常: ${err.message}` }
    }
  },

  /**
   * 模板文本渲染
   */
  async template_render(params, ctx) {
    const template = params?.template || ''
    const rendered = renderTemplate(template, ctx)
    return { ok: true, data: { result: rendered } }
  },

  /**
   * 联网全网搜索（转调成熟的 reach/platforms 通道）
   */
  async reach_search(params, ctx) {
    const query = renderTemplate(params?.query || '{{input}}', ctx)
    if (!query.trim()) return { ok: false, error: '搜索词为空' }

    try {
      const res = await webSearch(query, { maxResults: params?.maxResults || 3 })
      return { ok: true, data: { results: res?.results || [], total: res?.results?.length || 0 } }
    } catch (err) {
      return { ok: false, error: `搜索失败: ${err.message}` }
    }
  },
}

/**
 * 执行声明式 DSL 技能流水线
 * @param {object} dsl 技能定义规范
 * @param {object} initialContext 运行时输入上下文 { input: string, user: string, ... }
 */
export async function executeSkillPipeline(dsl, initialContext = {}) {
  if (!dsl || typeof dsl !== 'object') {
    return { ok: false, error: '无效的 DSL 技能配置' }
  }

  const pipeline = dsl.executionPlan?.pipeline
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return { ok: false, error: '技能未配置任何可执行流水线' }
  }

  const ctx = { ...initialContext }

  for (let i = 0; i < pipeline.length; i++) {
    const step = pipeline[i]
    const actionName = step.action

    const handler = ATOMIC_ACTIONS[actionName]
    if (!handler) {
      return { ok: false, error: `拒绝执行未注册动作: ${actionName}（第 ${i + 1} 步）` }
    }

    try {
      const stepRes = await handler(step.params || {}, ctx)
      if (!stepRes.ok) {
        if (step.ignoreError) {
          logger.warn(`[dsl-executor] 步骤 ${actionName} 忽略错误: ${stepRes.error}`)
          continue
        }
        return { ok: false, error: `步骤 ${actionName} 失败: ${stepRes.error}`, stepIndex: i }
      }

      // 将产物注入上下文供后续步骤使用
      if (stepRes.data) {
        Object.assign(ctx, stepRes.data)
        if (step.exportAs) {
          ctx[step.exportAs] = stepRes.data
        }
      }
    } catch (err) {
      return { ok: false, error: `执行异常: ${err.message}`, stepIndex: i }
    }
  }

  return { ok: true, context: ctx }
}
