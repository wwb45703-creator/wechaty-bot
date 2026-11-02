/** Product IPC integration using fake Electron, synthetic data and no app lifecycle. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../ui/main.js', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-product-ipc-fixture-'))
const configFile = path.join(root, 'config.json')
const sentinel = JSON.stringify({ ai: {}, astrbot: { enabled: true, baseUrl: 'http://127.0.0.1:6185' } })
fs.writeFileSync(configFile, sentinel)
const envKeys = ['BOT_DATA_ROOT', 'BOT_CONFIG_FILE', 'BOT_TEST_MODE']
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = configFile
process.env.BOT_TEST_MODE = '1'
let dialogResult = { canceled: true, filePaths: [] }, spawned = 0, networked = 0
const handlers = new Map()
const frame = { url: pathToFileURL(path.join(project, 'ui', 'renderer', 'index.html')).href }
const window = { isDestroyed: () => false, webContents: { mainFrame: frame } }
const event = { sender: window.webContents, senderFrame: frame }
const electron = {
  app: { setPath() {}, whenReady: () => ({ then() {} }), on() {}, getVersion: () => 'fixture' },
  BrowserWindow: class { static getAllWindows() { return [window] } },
  ipcMain: { handle(name, fn) { assert.equal(handlers.has(name), false); handlers.set(name, fn) } },
  Menu: {}, dialog: { showOpenDialog: async () => dialogResult },
}
const context = vm.createContext({
  require: name => name === 'electron' ? electron : name === 'child_process' ? { spawn() { spawned++; throw new Error('fixture prohibits processes') } } : require(name),
  __dirname: path.join(project, 'ui'),
  process: { env: { ...process.env, BOT_PROJECT_ROOT: project, BOT_UI_SMOKE: '' }, argv: [], resourcesPath: '', kill() { throw new Error('fixture prohibits process access') } },
  console, Buffer, AbortController, setTimeout, clearTimeout, setInterval() {},
  fetch() { networked++; throw new Error('fixture prohibits network') },
})
async function call(channel, payload) {
  assert.equal(typeof handlers.get(channel), 'function', `Missing IPC: ${channel}`)
  return handlers.get(channel)(event, payload)
}
try {
  new vm.Script(fs.readFileSync(path.join(project, 'ui', 'main.js'), 'utf8'), {
    filename: 'ui/main.js', importModuleDynamically: url => import(url),
  }).runInContext(context)
  const token = `fixture-${randomUUID()}`
  const saved = await call('astrbot:connection:save', { baseUrl: 'http://localhost:6186/', apiKey: token, enabled: true })
  assert.equal(saved.ok, true, saved.error)
  assert.equal(saved.data.hasApiKey, true)
  assert.equal(JSON.stringify(saved).includes(token), false)
  assert.equal((await call('astrbot:connection:get')).data.baseUrl, 'http://localhost:6186')
  assert.equal((await call('astrbot:connection:save', { baseUrl: 'https://external.example' })).ok, false)
  assert.equal((await call('astrbot:connection:save', { clearApiKey: true })).data.hasApiKey, false)
  assert.equal(fs.readFileSync(configFile, 'utf8'), sentinel)

  const created = await call('knowledge:create', { name: 'IPC 设备手册' })
  assert.equal(created.ok, true, created.error)
  const kbId = created.data.id
  assert.equal((await call('knowledge:list')).list[0].id, kbId)
  assert.equal((await call('knowledge:import', { kbId, name: 'manual.txt', text: '回流焊温度为 245 度，运行前检查急停按钮。' })).ok, true)
  const query = await call('knowledge:query', { kbId, query: '回流焊温度' })
  assert.equal(query.ok, true, query.error)
  assert.match(query.chunks[0].content, /245 度/)
  assert.equal((await call('knowledge:query', { kbId, query: '  ' })).ok, false)
  assert.equal((await call('knowledge:update', { id: kbId, enabled: false })).data.enabled, false)
  assert.equal((await call('knowledge:query', { query: '回流焊温度' })).chunks.length, 0)
  assert.equal((await call('knowledge:update', { id: kbId, enabled: true })).ok, true)

  const canceled = await call('knowledge:pick-document', { kbId })
  assert.equal(canceled.ok, true); assert.equal(canceled.canceled, true)
  const textFile = path.join(root, '进口文档.md')
  fs.writeFileSync(textFile, '\uFEFF设备使用说明：冷却温度为 25 度。')
  dialogResult = { canceled: false, filePaths: [textFile] }
  const imported = await call('knowledge:pick-document', { kbId })
  assert.equal(imported.ok, true, imported.error)
  assert.equal(imported.data.name, '进口文档.md')
  assert.equal((await call('knowledge:documents', { kbId })).list.length, 2)
  fs.writeFileSync(textFile, Buffer.from([0xff, 0xfe, 0x45, 0x00]))
  assert.equal((await call('knowledge:pick-document', { kbId })).ok, false)
  const unsupported = path.join(root, 'binary.exe')
  fs.writeFileSync(unsupported, 'synthetic fixture')
  dialogResult = { canceled: false, filePaths: [unsupported] }
  assert.equal((await call('knowledge:pick-document', { kbId })).ok, false)
  assert.equal((await call('knowledge:delete-document', { kbId, documentId: imported.data.id, confirmed: false })).ok, false)
  assert.equal((await call('knowledge:delete-document', { kbId, documentId: imported.data.id, confirmed: true })).ok, true)
  assert.equal((await call('knowledge:delete', { id: kbId, confirmed: false })).ok, false)
  assert.equal((await call('knowledge:delete', { id: kbId, confirmed: true })).ok, true)
  assert.equal((await call('knowledge:list')).list.length, 0)
  for (const name of ['knowledge:create', 'knowledge:query', 'astrbot:connection:save']) {
    assert.equal((await handlers.get(name)({ ...event, senderFrame: { url: frame.url } }, {})).ok, false)
  }
  assert.equal(spawned, 0)
  assert.equal(networked, 0)
  assert.equal(fs.readFileSync(configFile, 'utf8'), sentinel)
  console.log('PASS Product IPC: knowledge CRUD/retrieval/import/cancel/encoding/confirmations, connection persistence/redaction, sender checks and config sentinel; zero process/network effects')
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.match(path.basename(root), /^wechaty-product-ipc-fixture-/)
  fs.rmSync(root, { recursive: true, force: true })
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
}
