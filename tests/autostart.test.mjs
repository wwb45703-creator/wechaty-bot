/** Generate scripts only; never writes Windows Startup or runs a service. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { buildAutostartScript } = require('../ui/deployment-paths.cjs')
const deployment = { installed: true, projectRoot: 'D:\\安装 目录\\bot-runtime', dataRoot: 'D:\\用户 数据', configFile: 'D:\\用户 数据\\config.json', ollamaExe: 'D:\\安装 目录\\bot-runtime\\runtime\\ollama\\ollama.exe' }

test('installed user-enabled autostart restores all deployment paths and uses installed start launcher', () => {
  const source = buildAutostartScript(deployment)
  for (const [key, field] of [['BOT_PROJECT_ROOT','projectRoot'],['BOT_DATA_ROOT','dataRoot'],['BOT_CONFIG_FILE','configFile'],['BOT_OLLAMA_EXE','ollamaExe']]) {
    assert.ok(source.includes(`env("${key}") = "${deployment[field]}"`), key)
  }
  assert.ok(source.includes(path.join(deployment.projectRoot, 'scripts', 'installed-launcher.vbs')))
  assert.match(source, /installed-launcher\.vbs"" start", 0, False/)
  assert.doesNotMatch(source, /schtasks|Register-ScheduledTask|watchdog-launcher\.vbs|D:\\wechaty-bot\\/i)
})

test('source autostart uses the watchdog launcher without overriding deployment environment', () => {
  const source = buildAutostartScript({ ...deployment, installed: false })
  assert.ok(source.includes(path.join(deployment.projectRoot, 'scripts', 'watchdog-launcher.vbs')))
  assert.doesNotMatch(source, /env\("BOT_|installed-launcher\.vbs/)
})

test('VBS literals escape quotes and remove line breaks from synthetic deployment paths', () => {
  const source = buildAutostartScript({ ...deployment, projectRoot: 'D:\\fixture "quoted"\r\nINJECTED', dataRoot: 'D:\\fixture\nDATA' })
  assert.ok(source.includes('fixture ""quoted""INJECTED'))
  assert.ok(source.includes('env("BOT_DATA_ROOT") = "D:\\fixtureDATA"'))
  assert.ok(!source.split('\r\n').some(line => line.startsWith('INJECTED') || line.startsWith('DATA')))
})
