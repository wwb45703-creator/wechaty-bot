// 收集当前已打补丁的 node_modules 文件到项目 patches/ 目录（打包发行用）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, '..')
const targetBase = path.join(projectRoot, 'node_modules', 'wechaty-puppet-xp')
const patchesDir = path.join(projectRoot, 'patches')

const files = [
  'dist/esm/src/puppet-xp.js',
  'dist/cjs/src/puppet-xp.js',
  'dist/esm/src/init-agent-script.js',
  'dist/cjs/src/init-agent-script.js',
  'dist/esm/src/wechat-sidecar.js',
  'dist/cjs/src/wechat-sidecar.js',
]

for (const rel of files) {
  const src = path.join(targetBase, rel)
  const dst = path.join(patchesDir, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  console.log('collected:', rel, fs.statSync(dst).size, 'bytes')
}
console.log('done')
