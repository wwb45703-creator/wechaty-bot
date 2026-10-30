import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../ui/main.js', import.meta.url))
const { trustedSender } = require('../ui/ipc-policy.js')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-ui-ipc-fixture-'))
const sentinelFile = path.join(sandbox, 'existing-config.json')
const sentinel = JSON.stringify({ sentinel: 'must remain unchanged' })
fs.writeFileSync(sentinelFile, sentinel)
const oldEnv = Object.fromEntries(['BOT_DATA_ROOT', 'BOT_CONFIG_FILE', 'BOT_TEST_MODE'].map(key => [key, process.env[key]]))
const generatedRoots = []
let spawned = 0, networked = 0

async function loadMain({ projectRoot = root, resourcesPath = '' } = {}) {
  const handlers = new Map(), windows = []
  class Window {
    constructor(options) {
      assert.equal(options.show, false, 'smoke window must remain hidden')
      this.webContents = { mainFrame: { url: '' }, setWindowOpenHandler() {}, on() {}, once() {}, send() {} }
      windows.push(this)
    }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href }
    isDestroyed() { return false }
    static getAllWindows() { return windows }
  }
  const electron = { app: { setPath() {}, whenReady: () => Promise.resolve(), on() {}, quit() {} }, BrowserWindow: Window, ipcMain: { handle: (name, fn) => { assert.equal(handlers.has(name), false); handlers.set(name, fn) } }, Menu: { setApplicationMenu() {} }, dialog: {} }
  const proc = { env: { ...process.env, BOT_PROJECT_ROOT: projectRoot, BOT_CONFIG_FILE: sentinelFile, BOT_UI_SMOKE: '1', BOT_UI_SMOKE_REPORT: '', BOT_UI_SMOKE_SCREENSHOT: '' }, argv: [], resourcesPath, kill() { throw new Error('No real process access') } }
  const context = vm.createContext({ require: (name) => name === 'electron' ? electron : name === 'child_process' ? { spawn() { spawned++; throw new Error('spawn blocked') } } : require(name), __dirname: path.join(root, 'ui'), process: proc, console, setInterval() {}, setTimeout, clearTimeout, AbortController, Buffer, fetch() { networked++; throw new Error('network blocked') } })
  const script = new vm.Script(fs.readFileSync(path.join(root, 'ui', 'main.js'), 'utf8'), { filename: 'ui/main.js', importModuleDynamically: (url) => import(url) })
  script.runInContext(context)
  assert.notEqual(proc.env.BOT_CONFIG_FILE, sentinelFile)
  assert.equal(path.dirname(proc.env.BOT_CONFIG_FILE), proc.env.BOT_DATA_ROOT)
  assert.equal(fs.readFileSync(sentinelFile, 'utf8'), sentinel)
  generatedRoots.push(proc.env.BOT_DATA_ROOT)
  process.env.BOT_DATA_ROOT = proc.env.BOT_DATA_ROOT
  process.env.BOT_CONFIG_FILE = proc.env.BOT_CONFIG_FILE
  process.env.BOT_TEST_MODE = '1'
  await new Promise(resolve => setImmediate(resolve))
  const win = windows[0], event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  return { handlers, windows, event, proc }
}

try {
  const h = await loadMain()
  const { handlers, windows, event } = h
  assert.equal(trustedSender(event, windows, path.join(root, 'ui', 'renderer', 'index.html')), true)
  assert.equal((await handlers.get('getStatus')(event)).isolated, true)
  for (const channel of ['startBot', 'stopBot', 'startOllama', 'stopOllama', 'setAutostart', 'astrbot:plugins:install', 'testChat']) assert.equal((await handlers.get(channel)(event)).ok, false)
  assert.equal((await handlers.get('skills:list')({ ...event, senderFrame: { url: event.senderFrame.url } })).ok, false)
  const originalUrl = event.senderFrame.url
  event.senderFrame.url = 'https://evil.example/'
  assert.equal((await handlers.get('skills:list')(event)).ok, false)
  event.senderFrame.url = originalUrl

  const list = await handlers.get('skills:list')(event)
  assert.equal(list.ok, true, list.error)
  const source = await handlers.get('skills:propose')(event, { kind: 'bundled-example', id: 'jina-doc-reader' })
  assert.equal(source.ok, true, source.error)
  const evaluation = await handlers.get('skills:evaluate')(event, source.data.id)
  assert.equal(evaluation.data.passed, true)
  assert.equal((await handlers.get('skills:activate')(event, { id: source.data.id, hash: source.data.hash, confirmed: true })).ok, true)
  assert.equal((await handlers.get('skills:deactivate')(event, { skillId: 'jina-doc-reader', confirmed: false })).ok, false)
  assert.equal((await handlers.get('skills:deactivate')(event, { skillId: 'jina-doc-reader', confirmed: true })).ok, true)
  const inactive = await handlers.get('skills:list')(event)
  assert.equal(inactive.active['jina-doc-reader'], undefined)
  assert.ok(inactive.history['jina-doc-reader'].includes(source.data.hash))
  assert.equal((await handlers.get('skills:rollback')(event, { skillId: 'jina-doc-reader', hash: source.data.hash, confirmed: true })).ok, true)

  const social = await import(pathToFileURL(path.join(root, 'src', 'social', 'index.js')).href)
  const traces = await import(pathToFileURL(path.join(root, 'src', 'skills', 'tracer.js')).href)
  const a = { platform: 'wechat', accountId: 'fixture-account', conversationId: 'room:alpha', personaId: 'A', subjectId: 'shared-user' }
  const alternateRole = { ...a, personaId: 'B' }
  const otherRoom = { ...a, conversationId: 'room:beta' }
  const otherUser = { ...a, subjectId: 'other-user' }
  for (const [scope, text] of [[a, '用户偏好蓝色'], [alternateRole, '用户喜欢画画'], [otherRoom, '用户偏好绿色'], [otherUser, '用户爱听音乐']]) {
    social.recordObservation({ scope, sourceId: text, facts: [text], epoch: social.captureEpoch(scope) })
  }
  const legacyMarker = '旧全局资料不能混进当前会话'
  fs.writeFileSync(path.join(h.proc.env.BOT_DATA_ROOT, 'state', 'persona-state.json'), JSON.stringify({ name: legacyMarker }))
  for (const channel of ['getPersonaState', 'getEmotionState', 'getPersonaHistory', 'listRelationships', 'getRelationship', 'listMemories', 'getMemoryDetail']) {
    assert.equal((await handlers.get(channel)(event)).scopeRequired, true, channel)
  }
  for (const channel of ['getPersonaState', 'getEmotionState', 'listRelationships', 'getRelationship', 'listMemories', 'getMemoryDetail']) {
    const scoped = await handlers.get(channel)(event, a)
    assert.equal(scoped.ok, true, channel)
    assert.doesNotMatch(JSON.stringify(scoped), new RegExp(legacyMarker))
    assert.doesNotMatch(JSON.stringify(scoped), /用户偏好绿色/)
  }
  assert.equal((await handlers.get('getMemoryDetail')(event, 'private/shared-user.json')).scopeRequired, true)
  assert.equal((await handlers.get('deleteMemory')(event, 'private/shared-user.json')).ok, false)
  assert.equal((await handlers.get('deleteRelationship')(event, 'shared-user')).ok, false)
  const detail = await handlers.get('social:detail')(event, a)
  assert.equal(detail.ok, true)
  assert.equal(detail.data.memory.facts[0].text, '用户偏好蓝色')
  assert.ok(detail.data.memory.facts[0].sourceId)
  assert.equal(typeof detail.data.persona.traits['好奇心'], 'number')

  const trace = traces.recordInteractionTrace({ scope: a, userText: '不要回这么长', correction: '不要回这么长', actionName: 'conversation' })
  const proposed = await handlers.get('skills:propose')(event, { kind: 'trace-template', id: trace.id })
  assert.equal(proposed.ok, true)
  assert.equal((await handlers.get('social:forget')(event, { confirmed: false })).ok, false)
  assert.equal((await handlers.get('deleteMemory')(event, { scope: a, allConversations: false, confirmed: true })).ok, true)
  assert.equal(social.getSocialState(a).memory.facts.length, 0)
  assert.equal(social.getSocialState(alternateRole).memory.facts.length, 0)
  assert.equal(social.getSocialState(otherRoom).memory.facts.length, 1)
  assert.equal(social.getSocialState(otherUser).memory.facts.length, 1)
  assert.equal(traces.listInteractionTraces().some(row => row.id === trace.id), false)
  assert.equal((await handlers.get('skills:list')(event)).candidates.some(row => row.id === proposed.data.id), false)
  assert.equal((await handlers.get('social:forget')(event, { scope: a, allConversations: true, confirmed: true })).ok, true)
  assert.equal(social.getSocialState(otherRoom).memory.facts.length, 0)
  assert.equal(social.getSocialState(otherUser).memory.facts.length, 1)

  // Packaged fallback must not depend on an external src folder or production config.
  const resources = path.join(sandbox, 'resources')
  fs.mkdirSync(path.join(resources, 'bot-runtime'), { recursive: true })
  fs.cpSync(path.join(root, 'src'), path.join(resources, 'bot-runtime', 'src'), { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(resources, 'bot-runtime', 'package.json'))
  const legacyProject = path.join(sandbox, 'legacy-project')
  fs.mkdirSync(path.join(legacyProject, 'src', 'skills'), { recursive: true })
  fs.writeFileSync(path.join(legacyProject, 'src', 'skills', 'tracer.js'), "throw new Error('Legacy production source must not run during smoke')")
  const fallback = await loadMain({ projectRoot: legacyProject, resourcesPath: resources })
  assert.equal((await fallback.handlers.get('skills:list')(fallback.event)).ok, true)
  assert.equal((await fallback.handlers.get('social:list')(fallback.event)).ok, true)
  assert.equal((await fallback.handlers.get('getMemoryDetail')(fallback.event, a)).ok, true)
  assert.equal(fs.readFileSync(sentinelFile, 'utf8'), sentinel)
  assert.equal(spawned, 0)
  assert.equal(networked, 0)
  console.log('PASS UI IPC: trusted sender, explicit scope authority, complete forgetting, skill deactivate/reactivate, packaged fallback and forced smoke config isolation')
} finally {
  for (const directory of [...generatedRoots, sandbox]) {
    const resolved = path.resolve(directory)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(/^wechaty-ui-(?:smoke|ipc-fixture)-/.test(path.basename(resolved)))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
}
