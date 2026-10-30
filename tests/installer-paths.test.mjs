import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { resolveDeployment, initializeInstalledData } = require('../ui/deployment-paths.cjs')

test('installed distribution uses its chosen directory and separate writable user data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-installer-paths-'))
  try {
    const resources = path.join(root, '中文 安装路径', 'resources')
    const bundle = path.join(resources, 'bot-runtime')
    fs.mkdirSync(bundle, { recursive: true })
    fs.writeFileSync(path.join(bundle, 'distribution.json'), JSON.stringify({ format: 1, kind: 'wechaty-bot-offline' }))
    const deployment = resolveDeployment({ resourcesPath: resources, env: { LOCALAPPDATA: path.join(root, '用户 数据') } })
    assert.equal(deployment.installed, true)
    assert.equal(deployment.projectRoot, bundle)
    assert.equal(deployment.ollamaExe, path.join(bundle, 'runtime', 'ollama', 'ollama.exe'))
    assert.equal(deployment.dataRoot.startsWith(resources), false)
    assert.equal(deployment.configFile, path.join(root, '用户 数据', 'WechatyBotConsole', 'data', 'config.json'))
    fs.writeFileSync(path.join(bundle, 'config.defaults.json'), JSON.stringify({ ai: { provider: 'ollama' }, rooms: [] }))
    initializeInstalledData(deployment)
    assert.ok(fs.existsSync(path.join(deployment.dataRoot, 'state', 'bot-disabled.flag')))
    assert.ok(fs.existsSync(path.join(deployment.dataRoot, 'state', 'ollama-disabled.flag')))
    fs.writeFileSync(deployment.configFile, '{"custom":"user-owned"}')
    fs.unlinkSync(path.join(deployment.dataRoot, 'state', 'bot-disabled.flag'))
    initializeInstalledData(deployment)
    assert.equal(fs.readFileSync(deployment.configFile, 'utf8'), '{"custom":"user-owned"}')
    assert.equal(fs.existsSync(path.join(deployment.dataRoot, 'state', 'bot-disabled.flag')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('existing directory builds preserve legacy defaults and explicit data overrides', () => {
  const legacy = resolveDeployment({ env: {}, resourcesPath: path.join(os.tmpdir(), 'nonexistent-bot-resources') })
  assert.equal(legacy.installed, false)
  assert.equal(legacy.projectRoot, path.resolve('D:\\wechaty-bot'))
  const custom = resolveDeployment({ env: { BOT_PROJECT_ROOT: 'E:\\Custom Bot', BOT_DATA_ROOT: 'E:\\Bot Data', BOT_CONFIG_FILE: 'E:\\Bot Data\\chosen.json', BOT_OLLAMA_EXE: 'E:\\Ollama\\ollama.exe' } })
  assert.equal(custom.projectRoot, path.resolve('E:\\Custom Bot'))
  assert.equal(custom.dataRoot, path.resolve('E:\\Bot Data'))
  assert.equal(custom.configFile, path.resolve('E:\\Bot Data\\chosen.json'))
  assert.equal(custom.ollamaExe, 'E:\\Ollama\\ollama.exe')
})
