import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-connection-fixture-'))
const configFile = path.join(root, 'config.json')
const sentinel = JSON.stringify({ ai: {}, astrbot: { enabled: true, baseUrl: 'http://127.0.0.1:6185' }, personas: { fixture: '原始配置不可覆盖' } })
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = configFile
process.env.BOT_TEST_MODE = '1'
fs.writeFileSync(configFile, sentinel)
const connection = await import('../src/reach/astrbot-connection.js')
const filename = path.join(root, 'state', 'astrbot-connection.json')
test.after(() => {
  assert.equal(fs.readFileSync(configFile, 'utf8'), sentinel)
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.match(path.basename(root), /^wechaty-connection-fixture-/)
  fs.rmSync(root, { recursive: true, force: true })
})
test.beforeEach(() => { if (fs.existsSync(filename)) fs.unlinkSync(filename) })

test('connection edits persist separately, never reveal credentials, preserve a blank token and explicitly clear it', () => {
  const token = `fixture-${randomUUID()}`
  assert.equal(connection.publicAstrBotConnection().hasApiKey, false)
  const updated = connection.saveAstrBotConnection({ baseUrl: 'http://localhost:6186/', enabled: false, apiKey: token })
  assert.equal(updated.baseUrl, 'http://localhost:6186')
  assert.equal(updated.enabled, false)
  assert.equal(updated.hasApiKey, true)
  assert.doesNotMatch(JSON.stringify(updated), new RegExp(token))
  assert.equal(connection.readAstrBotConnection().apiKey, token)
  connection.saveAstrBotConnection({ enabled: true, apiKey: '' })
  assert.equal(connection.readAstrBotConnection().apiKey, token)
  assert.equal(connection.publicAstrBotConnection().enabled, true)
  const cleared = connection.saveAstrBotConnection({ clearApiKey: true })
  assert.equal(cleared.hasApiKey, false)
  assert.equal(connection.readAstrBotConnection().apiKey, '')
  assert.equal(fs.readFileSync(configFile, 'utf8'), sentinel)
})

test('invalid service destinations and header injection do not mutate a valid connection', () => {
  connection.saveAstrBotConnection({ baseUrl: 'http://127.0.0.1:6185' })
  const before = fs.readFileSync(filename, 'utf8')
  for (const baseUrl of ['https://example.com', 'http://127.0.0.1.evil.example', 'file:///fixture', 'http://user:pass@127.0.0.1:6185', 'http://127.0.0.1:6185?token=fixture', 'http://127.0.0.1:6185#fixture']) {
    assert.throws(() => connection.saveAstrBotConnection({ baseUrl }), undefined, baseUrl)
    assert.equal(fs.readFileSync(filename, 'utf8'), before)
  }
  assert.throws(() => connection.saveAstrBotConnection({ apiKey: 'fixture\r\nInjected: true' }), /格式/)
  assert.throws(() => connection.saveAstrBotConnection({ enabled: 'true' }), /布尔/)
  assert.equal(fs.readFileSync(filename, 'utf8'), before)
})

test('corrupt independent connection state fails visibly instead of replacing the user configuration', () => {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const broken = '{broken fixture'
  fs.writeFileSync(filename, broken)
  assert.throws(() => connection.publicAstrBotConnection(), /损坏/)
  assert.throws(() => connection.saveAstrBotConnection({ enabled: true }), /损坏/)
  assert.equal(fs.readFileSync(filename, 'utf8'), broken)
  assert.equal(fs.readFileSync(configFile, 'utf8'), sentinel)
})
