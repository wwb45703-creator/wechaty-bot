/**
 * 链接识别功能测试：
 *  1. URL 提取
 *  2. SSRF 防护（内网/环回/私有用例必须全部拒绝）
 *  3. 真实公网链接抓取（标题/正文解析）
 *  4. AI 人设回复链路（不依赖微信）
 * 用法：node scripts/test-link.mjs
 */
import { extractFirstUrl, validateExternalUrl, fetchPageText } from '../src/url-utils.js'
import { initAi, chat } from '../src/ai.js'
import config from '../src/config-loader.js'
import { initAi as _unused } from '../src/ai.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail) => {
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
  cond ? pass++ : fail++
}

// ---- 1. URL 提取 ----
ok('提取普通链接', extractFirstUrl('看看这个 https://example.com/news/123 挺有意思') === 'https://example.com/news/123')
ok('中文标点截断', extractFirstUrl('链接是 https://example.com/a。好看吗') === 'https://example.com/a')
ok('无链接返回 null', extractFirstUrl('今天天气不错') === null)

// ---- 2. SSRF 防护（全部必须拒绝） ----
initAi(config)
const ssrfCases = [
  ['http://127.0.0.1:11434/api/tags', '环回+端口'],
  ['http://localhost/admin', 'localhost'],
  ['http://192.168.1.1/', '私有 C 段'],
  ['http://10.0.0.5/', '私有 A 段'],
  ['http://172.16.0.1/', '172.16 段'],
  ['http://169.254.169.254/latest', '云元数据'],
  ['file:///etc/passwd', 'file 协议'],
]
for (const [u, label] of ssrfCases) {
  const r = await validateExternalUrl(u)
  ok(`SSRF 拒绝 [${label}]`, r.ok === false, r.error)
}

// 合法公网域名应通过校验
const valid = await validateExternalUrl('https://www.qq.com')
ok('公网域名通过校验', valid.ok === true)

// ---- 3. 真实公网链接抓取 ----
const page = await fetchPageText('https://www.qq.com', { timeoutMs: 15000 })
ok('公网页面抓取', page.ok === true, page.ok ? `kind=${page.kind} 摘要前60字: ${(page.summary || '').slice(0, 60).replace(/\n/g, ' ')}` : page.error)

// ---- 4. AI 人设回复链路（模拟群友分享链接，与 on-link.js 相同的调用形态） ----
if (page.ok) {
  initAi(config)
  const summary = page.summary.length > 600 ? page.summary.slice(0, 600) + '……' : page.summary
  const reply = await chat({
    key: 'link-once-test-' + Date.now(),
    userText: `鹅王 分享了一个链接，内容如下：\n${summary}\n\n直接输出你对这个链接内容的点评或吐槽（一两句话），只输出点评内容本身，不要任何开场白或说明。`,
    systemExtra: '当前是微信群"mc喵"的群聊，鹅王 分享了一个链接，你看完内容后主动点评。回复会自动@鹅王。',
  })
  ok('AI 人设回复生成', Boolean(reply), reply ? reply.slice(0, 80) : '(null)')
  // 回复不应包含特殊 token 残留或元话语
  ok('回复无特殊 token 残留', reply && !/\|im_end\||\|im_start\|/.test(reply))
} else {
  console.log('（跳过 AI 回复测试：公网抓取失败）')
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
