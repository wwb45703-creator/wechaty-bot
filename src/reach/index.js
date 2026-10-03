/**
 * reach 主入口：链接内容的分层降级抓取链。
 *
 *   L0 平台特化（B站官方API / yt-dlp / V2EX / gh CLI，硬编码域名白名单）
 *   L1 原生 fetch（url-utils.fetchPageText，零依赖最快）
 *   L2 Scrapling（scripts/reach_scrape.py，TLS 指纹伪装 + 正文提取/markdown；未装则跳过）
 *   L3 Jina Reader（第三方转读，默认关：r.jina.ai 部分网络不可达 + URL 会发给第三方）
 *   L4 patchright 无头渲染（可选依赖，未装则跳过）
 *
 * 返回统一格式：
 *   { ok: true,  kind: 'page'|'video', source, summary }
 *   { ok: false, error, attempts: [每层结论] }
 * L1 若只抓到很薄的内容（SPA 壳），视为"不满足"继续向下尝试。
 */

import config from '../config-loader.js'
import { logger } from '../logger.js'
import { fetchPageText } from '../url-utils.js'
import { runCli } from './spawn-utils.js'
import { platformFetch } from './platforms.js'
import { fetchViaJina } from './jina.js'
import { fetchViaBrowser } from './browser.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 内容太薄判定：SPA 壳页常见"标题+几十字"，继续尝试更重的层 */
function isThin(r) {
  if (!r.ok) return true
  if (r.kind === 'video') return false // 视频元数据本身就是结构化摘要
  return String(r.summary || '').length < 120
}

/** L2：spawn Python Scrapling 脚本（探测失败/超时/非 JSON 输出 → null） */
async function fetchViaScrapling(urlStr, opts) {
  if (config.reach?.scrapling?.enabled === false) return null
  const pythonBin = config.reach?.scrapling?.pythonBin || 'python'
  const script = path.resolve(__dirname, '../../scripts/reach_scrape.py')
  const maxChars = opts.summaryChars || 1200
  const r = await runCli(pythonBin, [script, urlStr, '--max-chars', String(Math.max(maxChars, 2000))], {
    timeoutMs: opts.timeoutMs || 30000,
    maxChars: 60000,
  })
  const out = (r.stdout || '').trim()
  if (r.code !== 0 || !out) {
    if (r.stderr && /ModuleNotFoundError|scrapling-not-installed|No module named/i.test(r.stderr + out)) {
      logger.info('[reach] 未安装 scrapling，L2 跳过（解锁：pip install "scrapling[fetchers]" markdownify）')
    } else if (r.spawnError || r.stderr) {
      logger.warn(`[reach] scrapling 层失败: ${(r.spawnError || r.stderr || '').split('\n')[0].slice(0, 120)}`)
    }
    return null
  }
  try {
    const data = JSON.parse(out)
    if (!data.ok || !data.text) return null
    let summary = ''
    if (data.title) summary += `标题：${data.title}\n`
    summary += `正文：${String(data.text).slice(0, maxChars)}`
    logger.info(`[reach] Scrapling命中 (${String(data.text).length} chars)`)
    return { ok: true, kind: 'page', source: 'scrapling', summary: summary.trim() }
  } catch {
    return null
  }
}

/**
 * 分层降级抓取主入口。
 * @param {string} urlStr 目标链接（来自聊天内容，每层都会过 validateExternalUrl）
 * @param {object} [opts] timeoutMs（单层上限）/ totalTimeoutMs（全链预算，默认 45s）/
 *                        maxBytes / summaryChars（沿用 links 段的取值）
 */
export async function fetchRich(urlStr, opts = {}) {
  const attempts = []
  const started = Date.now()

  // reach 整体关闭时退回纯 L1（行为与旧版一致）
  if (config.reach?.enabled === false) {
    return fetchPageText(urlStr, opts)
  }

  const totalBudget = opts.totalTimeoutMs || 45000
  const layerCap = opts.timeoutMs || 20000
  // 全链预算：每层最多用"剩余时间"，剩余不足 3s 时不再尝试更重的层
  const layerTimeout = () => Math.max(3000, Math.min(layerCap, totalBudget - (Date.now() - started)))
  const budgetLeft = () => totalBudget - (Date.now() - started) > 3000

  const layerOpts = () => ({
    timeoutMs: layerTimeout(),
    maxBytes: opts.maxBytes,
    summaryChars: opts.summaryChars,
  })

  // L0 平台特化
  try {
    const p = await platformFetch(urlStr, layerOpts())
    if (p) {
      if (p.fatal) return { ok: false, error: p.error, attempts } // SSRF 拦截，终态
      if (p.ok) return p
    }
    attempts.push('L0平台:未命中')
  } catch (err) {
    attempts.push(`L0平台:${err?.message || err}`)
  }

  // L1 原生 fetch
  const r1 = await fetchPageText(urlStr, layerOpts())
  if (r1.ok && !isThin(r1)) return { ...r1, source: 'native' }
  attempts.push(r1.ok ? 'L1原生:内容过薄' : `L1原生:${r1.error}`)

  // L2 Scrapling
  if (budgetLeft()) {
    try {
      const r2 = await fetchViaScrapling(urlStr, layerOpts())
      if (r2) return r2
      attempts.push('L2scrapling:无结果')
    } catch (err) {
      attempts.push(`L2scrapling:${err?.message || err}`)
    }
  } else attempts.push('L2scrapling:预算耗尽跳过')

  // L3 Jina Reader（默认关）
  if (budgetLeft()) {
    try {
      const r3 = await fetchViaJina(urlStr, layerOpts())
      if (r3) return r3
      attempts.push('L3jina:未启用或无结果')
    } catch (err) {
      attempts.push(`L3jina:${err?.message || err}`)
    }
  } else attempts.push('L3jina:预算耗尽跳过')

  // L4 浏览器渲染（可选依赖）
  if (budgetLeft()) {
    try {
      const r4 = await fetchViaBrowser(urlStr, layerOpts())
      if (r4) return r4
      attempts.push('L4浏览器:未安装或无结果')
    } catch (err) {
      attempts.push(`L4浏览器:${err?.message || err}`)
    }
  } else attempts.push('L4浏览器:预算耗尽跳过')

  // 全部未命中：L1 哪怕只拿到标题也保留旧版兜底行为（AI 至少能基于标题说两句）
  if (r1.ok) return { ...r1, source: 'native-thin' }
  return { ok: false, error: r1.error, attempts }
}
