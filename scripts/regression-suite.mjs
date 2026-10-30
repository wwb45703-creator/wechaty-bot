import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REQUIRED_TESTS = Object.freeze([
  'handler-integration.test.mjs', 'messaging.test.mjs', 'model-context.test.mjs',
  'network.test.mjs', 'skills-review.test.mjs', 'social-store.test.mjs',
  'reach-compat.test.mjs', 'preferences-compat.test.mjs',
  'bridge-compat.test.mjs',
  'image-compat.test.mjs',
  'delivery-recovery.test.mjs',
  'acceptance-forget-failures.test.mjs', 'skills-forget-retry.test.mjs', 'edge-safety.test.mjs',
])

/** Only this helper's freshly created temp directory may be removed. */
function sandboxRun(args) {
  const tempRoot = fs.realpathSync(os.tmpdir())
  const dir = fs.mkdtempSync(path.join(tempRoot, 'wechaty-regression-'))
  const resolved = fs.realpathSync(dir)
  if (path.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase() || !path.basename(resolved).startsWith('wechaty-regression-')) throw new Error('Unsafe test sandbox path')
  try {
    // Synthetic only: never read the user's config or copy private memories.
    const config = { ai: { baseUrl: 'http://127.0.0.1:11434', model: 'offline-fixture', replyDelaySeconds: [0, 0] },
      defaultPersona: 'A', personas: { A: '测试角色 A', B: '测试角色 B' }, private: { enabled: true, cooldownSeconds: 0 },
      rooms: [], defaultRoomMode: 'mention', defaultWakeWords: [], reach: { enabled: true, search: { enabled: true }, jina: { enabled: false } },
      astrbot: { enabled: false }, scheduler: { enabled: false } }
    const configFile = path.join(resolved, 'config.json')
    fs.writeFileSync(configFile, JSON.stringify(config), 'utf8')
    const env = { ...process.env, BOT_OFFLINE: '1', BOT_TEST_MODE: '1', BOT_DATA_ROOT: resolved,
      BOT_CONFIG_FILE: configFile, BOT_PROJECT_ROOT: PROJECT_ROOT }
    delete env.BOT_UI_SMOKE_REPORT
    const result = spawnSync(process.execPath, args, { cwd: resolved, env, encoding: 'utf8', windowsHide: true,
      timeout: 180000, maxBuffer: 8 * 1024 * 1024 })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) console.error(result.error.message)
    return result.status ?? 1
  } finally {
    if (fs.existsSync(resolved) && fs.realpathSync(resolved).toLowerCase() === resolved.toLowerCase()) fs.rmSync(resolved, { recursive: true, force: true })
  }
}

export function runRegression(names) {
  const files = names.map(name => {
    if (path.basename(name) !== name || !name.endsWith('.test.mjs')) throw new Error(`Invalid regression suite: ${name}`)
    const file = path.join(PROJECT_ROOT, 'tests', name)
    if (!fs.existsSync(file)) throw new Error(`Required regression suite is missing: ${name}`)
    return file
  })
  if (!files.length) throw new Error('No regression suites selected')
  return sandboxRun(['--test', ...files])
}

export function runIsolatedScript(name, nodeOptions = []) {
  if (path.basename(name) !== name) throw new Error('Invalid test entrypoint')
  const file = path.join(PROJECT_ROOT, 'scripts', name)
  if (!fs.existsSync(file)) throw new Error(`Required test entrypoint is missing: ${name}`)
  return sandboxRun([...nodeOptions, file])
}
