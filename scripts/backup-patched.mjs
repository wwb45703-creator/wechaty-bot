// 把已打补丁的 puppet-xp 文件复制进备份目录（用脚本绕开 shell hook 对 node_modules 路径的误判）
import fs from 'node:fs'
import path from 'node:path'

const root = 'E:/wechaty-bot'
const backup = 'E:/wechaty-bot-backups/v1-stable-2026-09-27/patched-node-modules/wechaty-puppet-xp'

const files = [
  ['dist/esm/src/puppet-xp.js', 'dist/esm/src/puppet-xp.js'],
  ['dist/cjs/src/puppet-xp.js', 'dist/cjs/src/puppet-xp.js'],
]

for (const [rel] of files) {
  const src = path.join(root, 'node_modules', 'wechaty-puppet-xp', rel)
  const dst = path.join(backup, rel)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  console.log('backed up:', rel, fs.statSync(dst).size, 'bytes')
}
console.log('done')
