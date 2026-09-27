// 把 dist-pkg 里的两个发行树上传到 editions 仓的 full/ 与 lite/ 目录（在线浏览源码）。
// 上传前扫描敏感信息，发现即中止。中文文件名 URL 编码。
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'wwb45703-creator/wechaty-bot-editions'
const token = execSync('gh auth token', { encoding: 'utf8' }).trim()
const H = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wechaty-bot-release',
}

const api = async (method, url, body) => {
  const res = await fetch('https://api.github.com' + url, {
    method,
    headers: { ...H, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (res.status === 404) return { status: 404, json: null } // GET 目标不存在属正常
  if (!res.ok && res.status !== 422) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 200)}`)
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

const SENSITIVE = ['mc喵', '49905010454', 'wxid_pwopzpn1x3ib32', '80be761fa50bfdc', '最难不过坚持', 'D:/Users/wwb', 'D:\\Users\\wwb', '三分诚七分帅', '15381898306', '吃着月饼赏月亮']

function walk(dir) {
  const out = []
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

// 收集两个发行树的文件
const trees = {
  full: walk(path.join('dist-pkg', 'wechaty-bot-full')),
  lite: walk(path.join('dist-pkg', 'wechaty-bot-lite')),
}

// 敏感信息扫描（含文件名与内容），发现即中止
let leaks = 0
for (const [name, files] of Object.entries(trees)) {
  for (const f of files) {
    const rel = path.relative(path.join('dist-pkg', `wechaty-bot-${name}`), f).replace(/\\/g, '/')
    const content = fs.readFileSync(f, 'utf8')
    for (const s of SENSITIVE) {
      if (rel.includes(s) || content.includes(s)) {
        console.error(`泄露警告: ${name}/${rel} 含敏感串 "${s}"，中止上传`)
        leaks++
      }
    }
  }
}
if (leaks) { console.error(`共 ${leaks} 处疑似泄露，已中止`); process.exit(1) }
console.log('敏感信息扫描通过 ✓（0 泄露）')

// 逐文件上传（PUT contents；获取各目录现有文件 sha 以便更新）
async function putFile(edition, rel, file) {
  const apiUrlPath = rel.split('/').map(encodeURIComponent).join('/')
  const url = `/repos/${REPO}/contents/${edition}/${apiUrlPath}`
  let sha = undefined
  const get = await api('GET', url)
  if (get.status === 200) sha = get.json.sha
  const content = fs.readFileSync(file).toString('base64')
  const body = { message: `sync: ${edition}/${rel}`, content }
  if (sha) body.sha = sha
  const r = await api('PUT', url, body)
  console.log(`  ${edition}/${rel} ${r.status === 201 ? '新增' : '更新'}`)
}

for (const [name, files] of Object.entries(trees)) {
  console.log(`上传 ${name}/ (${files.length} 个文件)...`)
  for (const f of files) {
    const rel = path.relative(path.join('dist-pkg', `wechaty-bot-${name}`), f).replace(/\\/g, '/')
    await putFile(name, rel, f)
  }
}

// README 更新：加目录结构说明
console.log('更新 README...')
const readmePath = 'dist-pkg/RELEASE-README.md'
let readme = fs.readFileSync(readmePath, 'utf8')
readme = readme.replace(
  '## 下载',
  '## 浏览源码\n\n两个版本的全部源码直接在本仓库浏览：**[full/](./full)**（增量版）、**[lite/](./lite)**（精简版）。Releases 提供同样的内容打包为 zip。\n\n## 下载',
)
// README 更新需要 sha（已存在）
let readmeSha
const getReadme = await api('GET', `/repos/${REPO}/contents/README.md`)
if (getReadme.status === 200) readmeSha = getReadme.json.sha
await api('PUT', `/repos/${REPO}/contents/README.md`, {
  message: 'docs: 目录结构说明（full/ 与 lite/ 源码浏览）',
  content: Buffer.from(readme, 'utf8').toString('base64'),
  ...(readmeSha ? { sha: readmeSha } : {}),
})
console.log('README 已更新')
console.log('\n完成: https://github.com/' + REPO)
