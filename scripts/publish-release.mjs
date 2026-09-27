// 诊断+重试发布：检查 repo 状态 → README → Release → 资产
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

const api = async (method, url, body, raw) => {
  const host = url.startsWith('uploads') ? 'https://uploads.github.com' : 'https://api.github.com'
  const res = await fetch(host + url, {
    method,
    headers: raw ? { ...H, 'Content-Type': 'application/zip' } : { ...H, 'Content-Type': 'application/json' },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  })
  const text = await res.text()
  console.log(`${method} ${url} -> ${res.status}`)
  if (!res.ok && res.status !== 422) console.log('  响应:', text.slice(0, 300))
  return { status: res.status, json: text ? (() => { try { return JSON.parse(text) } catch { return null } })() : null }
}

// 1. repo 状态
const repo = await api('GET', `/repos/${REPO}`)
if (repo.status !== 200) {
  console.log('仓库不存在，创建...')
  await api('POST', '/user/repos', {
    name: 'wechaty-bot-editions', private: false,
    description: '微信机器人发行包：增量版/精简版（Wechaty + puppet-xp + 本地 Ollama）',
  })
}

// 2. README（空仓库 Contents PUT 会自动建初始提交）
const readme = fs.readFileSync('dist-pkg/RELEASE-README.md', 'utf8')
const put = await api('PUT', `/contents/README.md`, {
  message: 'docs: 发行说明',
  content: Buffer.from(readme, 'utf8').toString('base64'),
})
if (put.status !== 201 && put.status !== 200) console.log('README 写入异常，继续尝试 Release')

// 3. Release v1.0.0（存在则复用）
let rel = await api('GET', `/releases/tags/v1.0.0`)
if (rel.status !== 200) {
  const created = await api('POST', `/releases`, {
    tag_name: 'v1.0.0', name: 'v1.0.0 · 增量版 + 精简版',
    body: [
      '## 两个版本',
      '- **wechaty-bot-full.zip** 增量版：文字聊天（多条连发+emoji）、长期记忆、多人格切换、定时发言、**看图吐槽**（需 qwen2.5vl:7b + 6GB 显存）',
      '- **wechaty-bot-lite.zip** 精简版：去掉看图与实验组件，无显卡也能跑，核心体验一致',
      '',
      '## 安装',
      '解压后**先读包内《安装与使用说明.md》**（含环境要求与注意事项）。核心步骤：`npm install` → `node scripts\\apply-patches.mjs` → 改 config → `start.bat`',
      '',
      '## 注意事项（必读）',
      '- 微信桌面版必须 **3.9.10.27** 且关闭自动升级',
      '- 注入方式违反微信软件许可协议，**存在账号风险，强烈建议小号**',
      '- 杀毒软件必加信任区',
      '- 长期记忆与聊天数据全部留在本机',
    ].join('\n'),
    draft: false, prerelease: false,
  })
  rel = created
}
const release = rel.json
if (!release?.id) { console.error('Release 创建失败'); process.exit(1) }

// 4. 上传资产
const existing = new Set((release.assets || []).map((a) => a.name))
for (const name of ['wechaty-bot-full.zip', 'wechaty-bot-lite.zip']) {
  if (existing.has(name)) { console.log('资产已存在:', name); continue }
  const file = path.join('dist-pkg', name)
  console.log(`上传 ${name} (${Math.round(fs.statSync(file).size / 1024)}KB)...`)
  const up = await api('POST', `/uploads/repos/${REPO}/releases/${release.id}/assets?name=${name}`, fs.readFileSync(file), true)
  console.log('  ->', up.json?.state || '', up.json?.browser_download_url || '')
}
console.log('\n发布页: https://github.com/' + REPO + '/releases')
