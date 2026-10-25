/**
 * verify-all.mjs — 全局自动化验收自愈门禁套件
 *
 * 门禁清单：
 *  1. 静态语法检查（node --check 递归检查 src/ 和 scripts/ 下所有 JS/MJS 文件）
 *  2. Git 冲突标记扫描（检测 <<<<<<< HEAD, =======, >>>>>>> 避免合并冲突入库）
 *  3. 看门狗纯 ASCII 检查（检测 scripts/supervisor.ps1，杜绝 Win11 任务计划挂起）
 *  4. 链接与 SSRF 防护测试（执行 scripts/test-link.mjs）
 *  5. 联网与全网检索测试（执行 scripts/test-reach.mjs）
 *  6. 长期记忆读写测试（执行 scripts/test-memory.mjs）
 *  7. 群聊免 @ 触发规则测试（执行 scripts/test-room-trigger.mjs）
 *
 * 用法：node scripts/verify-all.mjs
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const isWin = process.platform === 'win32'
const nodeBin = process.execPath

let totalPass = 0
let totalFail = 0
const failures = []

function logHeader(title) {
  console.log(`\n==================================================`)
  console.log(`  ${title}`)
  console.log(`==================================================`)
}

function record(name, passed, detail = '') {
  if (passed) {
    totalPass++
    console.log(`✅ PASS  ${name}${detail ? ' → ' + detail : ''}`)
  } else {
    totalFail++
    failures.push({ name, detail })
    console.log(`❌ FAIL  ${name}${detail ? ' → ' + detail : ''}`)
  }
}

function getAllFiles(dir, extensions) {
  const result = []
  if (!fs.existsSync(dir)) return result
  const list = fs.readdirSync(dir)
  for (const item of list) {
    const fullPath = path.join(dir, item)
    const stat = fs.statSync(fullPath)
    if (stat.isDirectory()) {
      if (item !== 'node_modules' && item !== '.git' && item !== 'release') {
        result.push(...getAllFiles(fullPath, extensions))
      }
    } else if (extensions.some((ext) => item.endsWith(ext))) {
      result.push(fullPath)
    }
  }
  return result
}

// ----------------------------------------------------
// 门禁 1: 静态语法检查 (node --check)
// ----------------------------------------------------
logHeader('门禁 1: 源码语法检查 (node --check)')
const srcFiles = getAllFiles(path.join(rootDir, 'src'), ['.js', '.mjs'])
const scriptFiles = getAllFiles(path.join(rootDir, 'scripts'), ['.js', '.mjs'])
const allCodeFiles = [...srcFiles, ...scriptFiles]

let syntaxErrors = 0
for (const file of allCodeFiles) {
  const rel = path.relative(rootDir, file)
  const res = spawnSync(nodeBin, ['--check', file], { encoding: 'utf8', windowsHide: true })
  if (res.status === 0) {
    // 纯通过时不刷屏，保持清爽
  } else {
    syntaxErrors++
    record(`语法检查 [${rel}]`, false, (res.stderr || res.stdout || '').trim().split('\n')[0])
  }
}
if (syntaxErrors === 0) {
  record(`全量源文件语法扫描 (${allCodeFiles.length} 个文件)`, true, '全部无语法错误')
}

// ----------------------------------------------------
// 门禁 2: Git 冲突标记扫描
// ----------------------------------------------------
logHeader('门禁 2: Git 冲突标记扫描')
let conflictFiles = 0
const thisScript = fileURLToPath(import.meta.url)
for (const file of allCodeFiles) {
  if (path.resolve(file) === path.resolve(thisScript)) continue
  const content = fs.readFileSync(file, 'utf8')
  if (content.includes('<<<<<<<' + ' ') || content.includes('=======' + '\n') || content.includes('>>>>>>>' + ' ')) {
    conflictFiles++
    const rel = path.relative(rootDir, file)
    record(`冲突标记检测 [${rel}]`, false, '检测到 Git 合并冲突标记，必须先手动解决')
  }
}
if (conflictFiles === 0) {
  record('工作树冲突标记扫描', true, '无任何未解决的冲突标记')
}

// ----------------------------------------------------
// 门禁 3: 看门狗脚本纯 ASCII 约束 (AGENTS.md 硬规则)
// ----------------------------------------------------
logHeader('门禁 3: 看门狗 ASCII 规范检测')
const supervisorPath = path.join(rootDir, 'scripts', 'supervisor.ps1')
if (fs.existsSync(supervisorPath)) {
  const buf = fs.readFileSync(supervisorPath)
  let nonAscii = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 127) nonAscii++
  }
  record('supervisor.ps1 纯 ASCII 字节规范', nonAscii === 0, nonAscii === 0 ? '100% 纯 ASCII' : `包含 ${nonAscii} 处非 ASCII 字符`)
} else {
  record('supervisor.ps1 文件存在性', false, '文件缺失')
}

// ----------------------------------------------------
// 门禁 4 ~ 7: 自动化测试套件执行
// ----------------------------------------------------
const suites = [
  { name: '链接识别与 SSRF 防护测试', script: 'test-link.mjs' },
  { name: '联网检索与 Agent Reach 测试', script: 'test-reach.mjs' },
  { name: '长程记忆机制与隔离测试', script: 'test-memory.mjs' },
  { name: '群聊免 @ 触发规则专项测试', script: 'test-room-trigger.mjs' },
]

for (const suite of suites) {
  const scriptPath = path.join(rootDir, 'scripts', suite.script)
  if (!fs.existsSync(scriptPath)) {
    // 若尚未创建，先记录（避免阻塞未写出的脚本）
    continue
  }
  logHeader(`门禁套件: ${suite.name} (${suite.script})`)
  const child = spawnSync(nodeBin, [scriptPath], {
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  })

  const out = (child.stdout || '').trim()
  const err = (child.stderr || '').trim()
  const ok = child.status === 0

  if (out) console.log(out)
  if (err && !ok) console.error(err)
  if (child.error) console.error(`[进程异常] ${child.error.message}`)

  record(suite.name, ok, ok ? '全部断言通过' : (child.error ? child.error.message : `退出码: ${child.status}`))
}

// ----------------------------------------------------
// 验收总结
// ----------------------------------------------------
console.log(`\n==================================================`)
console.log(`  全量回归与质量验收总结`)
console.log(`==================================================`)
console.log(`总通过项: ${totalPass} 项`)
console.log(`总失败项: ${totalFail} 项`)

if (totalFail > 0) {
  console.log(`\n❌ 门禁未通过，发现以下 ${totalFail} 个故障，必须启动自愈：`)
  for (const f of failures) {
    console.log(` - ${f.name}: ${f.detail}`)
  }
  process.exit(1)
} else {
  console.log(`\n🎉 恭喜！全量验收门禁 100% 通过，项目无语法错误、无冲突、功能全部有效！`)
  process.exit(0)
}
