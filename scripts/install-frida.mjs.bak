// One-shot helper: install the frida native binding from a locally
// downloaded prebuild tarball (avoids node-gyp / slow GitHub fetch).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const binJs = path.join(here, '..', 'node_modules', 'prebuild-install', 'bin.js')

const args = [
  binJs,
  '--runtime', 'node',
  '--target', process.versions.node,
  '--arch', 'x64',
  '--platform', 'win32',
  '--local-prebuilds', 'E:/wechaty-bot/prebuilds',
  '--verbose',
]

process.chdir(path.join(here, '..', 'node_modules', 'frida'))

const r = spawnSync(process.execPath, args, { stdio: 'inherit' })
if (r.status !== 0) {
  console.error('prebuild-install failed, exit code', r.status)
  process.exit(r.status ?? 1)
}
console.log('frida binding installed OK')
