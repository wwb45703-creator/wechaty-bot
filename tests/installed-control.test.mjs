import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-installed-control-'))
  const install = path.join(root, '安装 程序'), data = path.join(root, '用户 数据')
  fs.mkdirSync(path.join(install, 'scripts'), { recursive: true })
  for (const name of ['installed-control.ps1', 'installed-launcher.vbs']) fs.copyFileSync(path.join(project, 'scripts', name), path.join(install, 'scripts', name))
  const env = { ...process.env, BOT_PROJECT_ROOT: install, BOT_DATA_ROOT: data, BOT_CONFIG_FILE: path.join(data, 'config.json'), BOT_OLLAMA_EXE: path.join(install, 'runtime', 'ollama', 'ollama.exe') }
  const invoke = (action, args = [], overrides = {}) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(install, 'scripts', 'installed-control.ps1'), '-Action', action, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true, timeout: 12000 })
  const put = (relative, text = '') => { const file = path.join(install, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file }
  const prepare = () => {
    put('distribution.json', '{"kind":"installer-test"}')
    put('src/index.js', '// synthetic payload, never executed')
    put('runtime/node18/node.exe')
    put('runtime/ollama/ollama.exe')
    fs.mkdirSync(path.join(install, 'node_modules'), { recursive: true })
  }
  const cleanup = () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('wechaty-installed-control-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
  let result
  try { result = run({ root, install, data, env, invoke, put, prepare }) }
  catch (error) { cleanup(); throw error }
  if (result && typeof result.then === 'function') return result.finally(cleanup)
  cleanup()
  return result
}
function json(result) { assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message); return JSON.parse(result.stdout.trim()) }

test('installed validation resolves Unicode paths without creating data or touching services', () => fixture(f => {
  f.prepare()
  for (const action of ['start', 'stop', 'status', 'start-ollama', 'stop-ollama']) {
    const result = json(f.invoke(action, ['-ValidateOnly']))
    assert.equal(result.validateOnly, true)
    assert.equal(result.projectRoot, f.install)
    assert.equal(result.dataRoot, f.data)
    assert.equal(result.configFile, path.join(f.data, 'config.json'))
    for (const field of ['markerPresent', 'nodePresent', 'ollamaPresent', 'entryPresent', 'dependenciesPresent']) assert.equal(result[field], true)
    assert.equal(fs.existsSync(f.data), false, 'validation must not initialize flags, logs or user data')
  }
}))

test('installed validation can derive its runtime root from the relocated script', () => fixture(f => {
  f.prepare()
  const result = json(f.invoke('status', ['-ValidateOnly'], { BOT_PROJECT_ROOT: '' }))
  assert.equal(result.projectRoot, f.install)
  assert.equal(result.nodeExe, path.join(f.install, 'runtime', 'node18', 'node.exe'))
  assert.equal(fs.existsSync(f.data), false)
}))

test('a missing bundled Node never falls back to system Node or clears the disabled marker', () => fixture(f => {
  f.prepare()
  fs.unlinkSync(path.join(f.install, 'runtime', 'node18', 'node.exe'))
  fs.mkdirSync(path.join(f.data, 'state'), { recursive: true })
  const flag = path.join(f.data, 'state', 'bot-disabled.flag')
  fs.writeFileSync(flag, 'retained')
  fs.writeFileSync(path.join(f.data, 'config.json'), '{}')
  const result = f.invoke('start')
  assert.equal(result.status, 1, result.stdout)
  assert.match(JSON.parse(result.stdout).error, /system Node is never used/)
  assert.equal(fs.readFileSync(flag, 'utf8'), 'retained')
  assert.equal(fs.existsSync(path.join(f.data, 'state', 'bot.pid')), false)
}))

test('stopping an installed bot rejects a stale PID belonging to an unrelated Node process', () => fixture(f => {
  f.prepare()
  fs.mkdirSync(path.join(f.data, 'state'), { recursive: true })
  fs.writeFileSync(path.join(f.data, 'state', 'bot.pid'), String(process.pid))
  const result = json(f.invoke('stop'))
  assert.equal(result.stopped, false)
  assert.equal(fs.existsSync(path.join(f.data, 'state', 'bot-disabled.flag')), true)
  assert.equal(fs.existsSync(path.join(f.data, 'state', 'bot.pid')), false)
  assert.equal(process.kill(process.pid, 0), true, 'the unrelated test runner remains alive')
}))

test('stopping Ollama never kills a shared service or trusts a foreign PID file', () => fixture(f => {
  f.prepare()
  fs.mkdirSync(path.join(f.data, 'state'), { recursive: true })
  fs.writeFileSync(path.join(f.data, 'state', 'installed-ollama.pid'), String(process.pid))
  const result = json(f.invoke('stop-ollama'))
  assert.equal(result.stopped, false)
  assert.match(result.note, /shared services remain running/)
  assert.equal(fs.existsSync(path.join(f.data, 'state', 'ollama-disabled.flag')), true)
  assert.equal(process.kill(process.pid, 0), true)
}))

test('the VBS launcher waits and propagates an action failure from a path containing spaces', () => fixture(f => {
  f.put('distribution.json', '{}')
  const result = spawnSync('cscript.exe', ['//Nologo', path.join(f.install, 'scripts', 'installed-launcher.vbs'), 'start'], { env: f.env, encoding: 'utf8', windowsHide: true, timeout: 12000 })
  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.match(fs.readFileSync(path.join(f.data, 'logs', 'installed-control.log'), 'utf8'), /Installation component is missing/)
  assert.equal(fs.existsSync(path.join(f.data, 'state', 'bot.pid')), false)
}))

test('stop reports an unowned runtime as an error and preserves evidence instead of claiming success', () => fixture(async f => {
  f.prepare()
  const nodeExe = path.join(f.install, 'runtime', 'node18', 'node.exe')
  fs.copyFileSync(process.execPath, nodeExe)
  const child = spawn(nodeExe, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.install, env: f.env, windowsHide: true, stdio: 'ignore' })
  try {
    await once(child, 'spawn')
    fs.mkdirSync(path.join(f.data, 'state'), { recursive: true })
    const pidFile = path.join(f.data, 'state', 'bot.pid')
    const ownerFile = pidFile + '.owner.json'
    const owner = JSON.stringify({ pid: child.pid, exe: nodeExe, startedTicks: '0' })
    fs.writeFileSync(pidFile, String(child.pid))
    fs.writeFileSync(ownerFile, owner)
    const result = f.invoke('stop')
    assert.equal(result.status, 1, result.stdout || result.stderr)
    assert.match(JSON.parse(result.stdout).error, /untracked process already uses this installation runtime/)
    assert.equal(process.kill(child.pid, 0), true, 'the ambiguous process must remain alive')
    assert.equal(fs.readFileSync(pidFile, 'utf8'), String(child.pid), 'keep the PID for manual diagnosis')
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), owner, 'keep the rejected owner evidence')
    assert.equal(fs.existsSync(path.join(f.data, 'state', 'bot-disabled.flag')), true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  }
}))
