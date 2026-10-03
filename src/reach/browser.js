/**
 * L4 浏览器渲染兜底：patchright（Playwright 免检测补丁版，Node 原生包）无头渲染
 * SPA/强反爬页面后取渲染完成的 HTML。
 *
 * 可选依赖设计（不装也能全站正常运行）：
 *  - 解锁：npm i patchright && npx patchright install chromium（约 400MB）
 *  - 未安装时 import 失败 → 永久缓存"不可用"，日志提示解锁命令，不再反复尝试
 *
 * 残余风险说明：浏览器进程自行解析 DNS，Node 侧 validateExternalUrl 只能做一次前置校验，
 * 无法覆盖浏览器内的二次解析（DNS rebinding 理论上可行）——与"用户点开链接"的语义等价，
 * 风险边界同 Jina 层；配置 reach.browser.enabled 可整体关闭。
 */

import config from '../config-loader.js'
import { logger } from '../logger.js'
import { validateExternalUrl } from '../url-utils.js'

let patchrightState = undefined // undefined=未探测 / null=不可用 / 模块对象
let launchBroken = false // 模块在但浏览器没装（同样缓存，防每次链接都慢启动一次）

async function getLauncher() {
  if (patchrightState !== undefined) return patchrightState
  try {
    patchrightState = await import('patchright')
  } catch {
    patchrightState = null
    logger.info('[reach] 未安装 patchright，浏览器渲染层跳过（解锁：npm i patchright && npx patchright install chromium）')
  }
  return patchrightState
}

/**
 * 返回 {ok, kind:'page', source:'browser', summary} 或 null（未启用/未装/失败）。
 * summary 由渲染后的 HTML 提取（复用 url-utils 的正文/标题提取）。
 */
export async function fetchViaBrowser(urlStr, opts = {}) {
  if (config.reach?.browser?.enabled === false) return null
  const v = await validateExternalUrl(urlStr)
  if (!v.ok) return null

  const mod = await getLauncher()
  if (!mod || launchBroken) return null

  const timeoutMs = opts.timeoutMs || 45000
  let browser = null
  try {
    browser = await mod.chromium.launch({ headless: true })
    launchBroken = false
  } catch (err) {
    launchBroken = true
    logger.warn(`[reach] patchright 启动失败（浏览器未装？）: ${err?.message || err}`)
    return null
  }

  try {
    const page = await browser.newPage()
    await page.goto(v.url.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    // 尽力等网络空闲（SPA 拉数据），超时不视为失败
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    const html = await page.content()
    const { htmlToText, extractMeta } = await import('../url-utils.js')
    const { title, description } = extractMeta(html)
    const bodyText = htmlToText(html).slice(0, opts.summaryChars || 1200)
    if (!title && !description && !bodyText) return null
    let summary = ''
    if (title) summary += `标题：${title}\n`
    if (description) summary += `简介：${description}\n`
    if (bodyText) summary += `正文摘录：${bodyText}`
    logger.info(`[reach] 浏览器渲染命中 (${html.length} bytes html)`)
    return { ok: true, kind: 'page', source: 'browser', summary: summary.trim() }
  } catch (err) {
    logger.warn(`[reach] 浏览器渲染失败: ${err?.message || err}`)
    return null
  } finally {
    try { await browser?.close() } catch { /* 无害 */ }
  }
}
