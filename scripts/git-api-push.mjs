// 通过 GitHub Git Data API 推送提交（绕开 github.com:443 直连被阻断的问题，
// 只依赖长期稳定的 api.github.com）。
// 用法：node scripts/git-api-push.mjs "提交备注"
// 原理：本地计算每个 tracked 文件的 git blob sha → 与远端 tree 对比 →
//       只上传变化的 blob → 组装 tree → 创建 commit → 移动 refs/heads/main
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const REPO = 'wwb45703-creator/wechaty-bot'
const message = process.argv[2] || 'update'
const token = execSync('gh auth token', { encoding: 'utf8' }).trim()

const api = async (method, url, body) => {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'wechaty-bot-push',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${await res.text()}`)
  return res.json()
}

const gitSha = (file) => {
  const content = fs.readFileSync(file)
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')
}

// 1. 本地 tracked 文件清单（.gitignore 自动生效；禁用中文路径的八进制转义）
const files = execSync('git -c core.quotepath=false ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)

// 2. 远端 main 的最新 commit + tree（不存在则全新建仓；空仓库 GET ref 返回 409）
const ref = await api('GET', 'git/ref/heads/main').catch((e) => {
  if (String(e).includes('409') || String(e).includes('404')) return null
  throw e
})
let baseCommit = ref?.object?.sha || null

// 空仓库：用 Contents API 塞入 README 建立初始提交（Contents API 在空仓库上可用，
// 之后 Git Data API 才不再报 "Git Repository is empty"）
if (!baseCommit) {
  const readme = files.find((f) => f.toLowerCase() === 'readme.md')
  if (readme) {
    const content = fs.readFileSync(readme).toString('base64')
    const initResp = await api('PUT', `contents/${readme}`, {
      message: 'init: README',
      content,
    })
    baseCommit = initResp?.commit?.sha || null
    console.log('空仓库已通过 README 初始化')
  }
}
const baseTreeSha = baseCommit ? (await api('GET', `git/commits/${baseCommit}`)).tree.sha : null
const remoteEntries = baseTreeSha ? (await api('GET', `git/trees/${baseTreeSha}?recursive=1`)).tree : []
const remoteMap = new Map(remoteEntries.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]))

// 3. 计算变化：新增/修改的本地文件 + 远端有而本地没有的（删除）
const tree = []
let changed = 0
for (const f of files) {
  const sha = gitSha(f)
  if (remoteMap.get(f) === sha) continue // 未变化
  const blob = await api('POST', 'git/blobs', {
    content: fs.readFileSync(f).toString('base64'),
    encoding: 'base64',
  })
  tree.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha })
  changed++
  process.stdout.write(`+ ${f}\n`)
}
const localSet = new Set(files.map((f) => f.replace(/\\/g, '/')))
for (const [p] of remoteMap) {
  if (!localSet.has(p)) {
    tree.push({ path: p, mode: '100644', type: 'blob', sha: null }) // 删除
    changed++
    process.stdout.write(`- ${p}\n`)
  }
}
if (changed === 0) {
  console.log('没有变化，无需推送')
  process.exit(0)
}

// 4. 组装 tree → commit → 移动/创建 main 引用
const newTree = await api('POST', 'git/trees', {
  base_tree: baseTreeSha || undefined,
  tree,
})
const newCommit = await api('POST', 'git/commits', {
  message,
  tree: newTree.sha,
  parents: baseCommit ? [baseCommit] : [],
})
if (baseCommit) {
  await api('PATCH', 'git/refs/heads/main', { sha: newCommit.sha, force: false })
} else {
  await api('POST', 'git/refs', { ref: 'refs/heads/main', sha: newCommit.sha })
}
console.log(`已推送 ${changed} 个变更 -> main @ ${newCommit.sha.slice(0, 7)} : "${message}"`)
