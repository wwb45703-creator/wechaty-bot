/**
 * reach 联网层功能测试（不依赖微信）：
 *  1. 搜索意图检测与搜索词清洗
 *  2. SSRF 防护在 reach 链路上的贯通（内网/环回必须全部拒绝）
 *  3. 必应搜索真实查询
 *  4. Scrapling 抓取脚本（L2，直接调 python）
 *  5. 分层降级链：普通页面（L1 命中）+ B站视频（L0 平台 API 命中）
 *  6. spawn 零闪窗封装基础行为
 * 用法：node scripts/test-reach.mjs
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectSearchIntent } from '../src/handlers/search.js'
import { sanitizeQuery, bingSearch } from '../src/reach/search.js'
import { fetchRich } from '../src/reach/index.js'
import { platformFetch } from '../src/reach/platforms.js'
import { runCli, hasCli } from '../src/reach/spawn-utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---- 1. 搜索意图检测 ----
ok('触发词"搜一下"', detectSearchIntent('搜一下 显卡价格') === '显卡价格')
ok('触发词"帮我搜"', detectSearchIntent('帮我搜 最近的电影') === '最近的电影')
ok('长触发词优先（"帮我搜索一下"不被截断）', detectSearchIntent('帮我搜索一下 Ollama') === 'Ollama')
ok('仅触发词无内容返回 null', detectSearchIntent('搜一下') === null)
ok('非触发词返回 null', detectSearchIntent('今天天气不错') === null)
ok('搜索词清洗（引号/尖括号移除）', sanitizeQuery('显卡"价格"<2026>') === '显卡 价格 2026')

// ---- 2. SSRF 防护贯通 reach 链路（全部必须拒绝且不进任何层） ----
const ssrfCases = [
  'http://127.0.0.1:11434/api/tags',
  'http://localhost/admin',
  'http://192.168.1.1/',
  'http://169.254.169.254/latest',
]
for (const u of ssrfCases) {
  const r = await fetchRich(u, { timeoutMs: 8000 })
  const rejected = r.ok === false && !String(r.error || '').includes('所有方式')
  ok(`reach 链路 SSRF 拒绝 [${u.slice(0, 30)}]`, rejected, r.error)
}
// L0 平台路由对内网 URL 直接终态
const pBad = await platformFetch('http://127.0.0.1/x', { timeoutMs: 5000 })
ok('L0 平台路由 SSRF 终态', pBad && pBad.fatal === true && pBad.ok === false)

// ---- 3. 必应搜索 ----
const sr = await bingSearch('patchright playwright', { numResults: 4 })
ok('必应搜索返回结果', Array.isArray(sr) && sr.length > 0, sr ? `${sr.length} 条，首条: ${sr[0].title.slice(0, 40)}` : 'null')
ok('搜索结果字段完整', sr && sr.every((r) => r.title && r.url && /^https?:\/\//.test(r.url)))

// ---- 4. Scrapling 脚本（L2） ----
const py = spawnSync('python', [path.join(__dirname, 'reach_scrape.py'), 'https://httpbin.org/html', '--max-chars', '300'], {
  encoding: 'utf8', timeout: 90000, windowsHide: true,
})
let scraped = null
try { scraped = JSON.parse((py.stdout || '').trim()) } catch { /* 解析失败按失败算 */ }
ok('Scrapling 脚本输出 JSON', scraped && scraped.ok === true && scraped.text.length > 50,
  scraped ? `text 前50字: ${scraped.text.slice(0, 50)}` : `stdout=${(py.stdout || '').slice(0, 80)} stderr=${(py.stderr || '').slice(0, 80)}`)

// ---- 5. 分层降级链 ----
const page = await fetchRich('https://www.qq.com', { timeoutMs: 15000 })
ok('普通页面 L1 命中', page.ok === true && page.source === 'native',
  page.ok ? `source=${page.source} 摘要前50字: ${(page.summary || '').slice(0, 50).replace(/\n/g, ' ')}` : JSON.stringify(page.attempts))

// B站视频走 L0 官方 API（kind=video）
const bili = await fetchRich('https://www.bilibili.com/video/BV1Wqaz6PEkZ', { timeoutMs: 20000 })
ok('B站视频 L0 API 命中', bili.ok === true && bili.kind === 'video' && bili.source === 'bilibili',
  bili.ok ? bili.summary.split('\n')[0] : JSON.stringify(bili.attempts))

// V2EX 主题页走 L0 API（不预置具体主题号，验证链路不崩且返回结构化结果）
const v2 = await fetchRich('https://www.v2ex.com/t/1', { timeoutMs: 20000 })
ok('V2EX 链路结构化返回（不崩）', v2 && typeof v2.ok === 'boolean', v2.ok ? `source=${v2.source}` : `error=${v2.error}`)

// ---- 6. spawn 封装 ----
const hasYt = await hasCli('yt-dlp')
ok('hasCli 探测 yt-dlp', hasYt === true)
const noCmd = await runCli('definitely-not-exist-cmd-xyz', [], { timeoutMs: 5000 })
ok('不存在的命令安全失败', noCmd.code !== 0, `code=${noCmd.code} stderr=${(noCmd.stderr || '').slice(0, 40)}`)
const echo = await runCli('node', ['-e', 'console.log("reach-ok")'], { timeoutMs: 10000 })
ok('runCli 基础执行', echo.code === 0 && echo.stdout.trim() === 'reach-ok', echo.stdout.trim())

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
