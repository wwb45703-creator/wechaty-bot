/**
 * 补丁安装器：把 patches/ 里的已修改文件覆盖到 node_modules 对应位置。
 * 安装完依赖（npm install）后必须运行一次：
 *   node scripts/apply-patches.mjs
 * 微信机器人能否收发群消息/解析群名，全靠这几个补丁。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')
const patchesDir = path.join(projectRoot, 'patches')
const targetBase = path.join(projectRoot, 'node_modules', 'wechaty-puppet-xp')

const files = [
  'dist/esm/src/puppet-xp.js',
  'dist/cjs/src/puppet-xp.js',
  'dist/esm/src/init-agent-script.js',
  'dist/cjs/src/init-agent-script.js',
  'dist/esm/src/wechat-sidecar.js',
  'dist/cjs/src/wechat-sidecar.js',
]

if (!fs.existsSync(patchesDir)) {
  console.error('未找到 patches/ 目录，请确认下载完整。')
  process.exit(1)
}

let ok = 0
for (const rel of files) {
  const src = path.join(patchesDir, rel)
  const dst = path.join(targetBase, rel)
  if (!fs.existsSync(src)) {
    console.error('缺少补丁文件:', rel)
    continue
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  ok++
  console.log('已应用补丁:', rel)
}
console.log(ok === files.length ? `\n全部 ${ok} 个补丁应用成功 ✓` : `\n警告：只应用了 ${ok}/${files.length} 个补丁！`)
