/**
 * 发行打包：生成 增量版(full) 与 精简版(lite) 两个 zip 到 dist-pkg/。
 *   node scripts/build-dist.mjs
 * 精简版 = 全功能版裁掉：看图说话(视觉链路)、拍一拍残留、诊断/实验脚本、守护进程。
 * 裁剪后逐文件做语法校验，失败即中止。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const outRoot = path.join(root, 'dist-pkg')
const nodeExe = path.join(root, 'runtime', 'node18', 'node.exe')

fs.rmSync(outRoot, { recursive: true, force: true })

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.cpSync(src, dst, { recursive: true })
}

// ---------- 增量版 (full) ----------
const fullDir = path.join(outRoot, 'wechaty-bot-full')
copy(path.join(root, 'src'), path.join(fullDir, 'src'))
copy(path.join(root, 'patches'), path.join(fullDir, 'patches'))
fs.mkdirSync(path.join(fullDir, 'scripts'), { recursive: true })
fs.copyFileSync(path.join(root, 'scripts', 'apply-patches.mjs'), path.join(fullDir, 'scripts', 'apply-patches.mjs'))
fs.copyFileSync(path.join(root, 'package.json'), path.join(fullDir, 'package.json'))
fs.copyFileSync(path.join(root, 'start.bat'), path.join(fullDir, 'start.bat'))
fs.copyFileSync(path.join(root, 'start.ps1'), path.join(fullDir, 'start.ps1'))
fs.copyFileSync(path.join(root, 'config.example.json'), path.join(fullDir, 'config.example.json'))
fs.copyFileSync(path.join(root, 'docs', 'INSTALL-full.md'), path.join(fullDir, '安装与使用说明.md'))
console.log('full 目录就绪')

// ---------- 精简版 (lite) ----------
const liteDir = path.join(outRoot, 'wechaty-bot-lite')
const liteSrc = path.join(liteDir, 'src')
copy(path.join(root, 'src'), liteSrc)
copy(path.join(root, 'patches'), path.join(liteDir, 'patches'))
fs.mkdirSync(path.join(liteDir, 'scripts'), { recursive: true })
fs.copyFileSync(path.join(root, 'scripts', 'apply-patches.mjs'), path.join(liteDir, 'scripts', 'apply-patches.mjs'))
fs.copyFileSync(path.join(root, 'package.json'), path.join(liteDir, 'package.json'))
fs.copyFileSync(path.join(root, 'start.bat'), path.join(liteDir, 'start.bat'))
fs.copyFileSync(path.join(root, 'start.ps1'), path.join(liteDir, 'start.ps1'))
fs.copyFileSync(path.join(root, 'docs', 'INSTALL-lite.md'), path.join(liteDir, '安装与使用说明.md'))
// lite 配置示例 = 完整示例去掉 vision 段
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'))
delete cfg.vision
fs.writeFileSync(path.join(liteDir, 'config.example.json'), JSON.stringify(cfg, null, 2), 'utf8')
console.log('lite 目录就绪（代码裁剪见下方校验）')

// lite 裁剪 1：on-message.js 去掉图片路由
const omPath = path.join(liteSrc, 'handlers', 'on-message.js')
let om = fs.readFileSync(omPath, 'utf8')
om = om.replace(/import \{ handleImageMessage, isVisionEnabled \} from '\.\/on-image\.js'\n/, '')
om = om.replace(/\n\s*\/\/ 看图说话：图片消息单独走视觉链路（私聊\+群聊）\n\s*if \(type === types\.Message\.Image && isVisionEnabled\(\)\) \{\n\s*await handleImageMessage\(msg, room\)\n\s*return\n\s*\}\n/, '\n')
fs.writeFileSync(omPath, om, 'utf8')

// lite 裁剪 2：ai.js 去掉 describeImage
const aiPath = path.join(liteSrc, 'ai.js')
let ai = fs.readFileSync(aiPath, 'utf8')
ai = ai.replace(/\/\*\*\n \* 看图说话：把本地图片发给视觉模型[\s\S]*?\n\}\n\n/, '')
ai = ai.replace(/import fs from 'node:fs'\nimport path from 'node:path'\n/, '')
fs.writeFileSync(aiPath, ai, 'utf8')

// lite 裁剪 3：删除视觉相关文件
fs.rmSync(path.join(liteSrc, 'handlers', 'on-image.js'), { force: true })
fs.rmSync(path.join(liteSrc, 'image-utils.js'), { force: true })

// ---------- 语法校验（两个版本的全部 js） ----------
function checkDir(dir) {
  const bad = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) { walk(p); continue }
      if (!p.endsWith('.js') && !p.endsWith('.mjs')) continue
      try {
        execSync(`"${nodeExe}" --check "${p}"`, { stdio: 'pipe' })
      } catch (e) {
        bad.push(p + ' :: ' + (e.stderr || e.message).toString().slice(0, 200))
      }
    }
  }
  walk(dir)
  return bad
}
const badFull = checkDir(fullDir)
const badLite = checkDir(liteDir)
if (badFull.length || badLite.length) {
  console.error('语法校验失败：', badFull, badLite)
  process.exit(1)
}
console.log('语法校验通过 ✓')

// ---------- lite 回归：无视觉残留 ----------
const liteStray = []
for (const f of ['src/handlers/on-image.js', 'src/image-utils.js']) {
  if (fs.existsSync(path.join(liteDir, f))) liteStray.push(f)
}
if (fs.readFileSync(path.join(liteDir, 'src', 'handlers', 'on-message.js'), 'utf8').includes('on-image')) liteStray.push('on-message 残留引用')
if (fs.readFileSync(path.join(liteDir, 'src', 'ai.js'), 'utf8').includes('describeImage')) liteStray.push('ai.js 残留 describeImage')
if (liteStray.length) { console.error('精简版残留：', liteStray); process.exit(1) }
console.log('精简版无视觉残留 ✓')

// ---------- 打 zip ----------
const sevenZip = false
for (const name of ['wechaty-bot-full', 'wechaty-bot-lite']) {
  const srcDir = path.join(outRoot, name)
  const zipPath = path.join(outRoot, `${name}.zip`)
  fs.rmSync(zipPath, { force: true })
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -Force"`, { stdio: 'pipe' })
  console.log('打包完成:', zipPath, Math.round(fs.statSync(zipPath).size / 1024) + 'KB')
}
