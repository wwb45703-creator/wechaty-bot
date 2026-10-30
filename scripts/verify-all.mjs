/** Offline regression gate. Never imports production config or starts platform services. */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { runRegression, runIsolatedScript, REQUIRED_TESTS, PROJECT_ROOT } from './regression-suite.mjs'

let passed = 0, failed = 0
function record(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  ok ? passed++ : failed++
}
function filesIn(dir, extensions) {
  const files = []
  if (!fs.existsSync(dir)) return files
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['node_modules', '.git', 'release', 'release-qa'].includes(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...filesIn(file, extensions))
    else if (entry.isFile() && extensions.includes(path.extname(file))) files.push(file)
  }
  return files
}

const source = ['src', 'scripts', 'ui', 'tests'].flatMap(dir => filesIn(path.join(PROJECT_ROOT, dir), ['.js', '.mjs', '.cjs']))
const syntaxFailures = []
for (const file of source) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (result.status !== 0) syntaxFailures.push(`${path.relative(PROJECT_ROOT, file)}: ${(result.stderr || result.error?.message || '').trim()}`)
}
record(`JavaScript syntax (${source.length} files)`, syntaxFailures.length === 0, syntaxFailures.join('\n'))

const text = ['src', 'scripts', 'ui', 'tests'].flatMap(dir => filesIn(path.join(PROJECT_ROOT, dir), ['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.ps1', '.py', '.vbs']))
const conflicts = text.filter(file => /^(?:<{7} |={7}$|>{7} )/m.test(fs.readFileSync(file, 'utf8')))
record('Merge conflict markers', conflicts.length === 0, conflicts.map(file => path.relative(PROJECT_ROOT, file)).join(', '))
const supervisor = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'supervisor.ps1'))
record('supervisor.ps1 ASCII', supervisor.every(value => value <= 127))
const controller = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'bot-ctl.ps1'))
record('bot-ctl.ps1 UTF-8 BOM', controller[0] === 0xef && controller[1] === 0xbb && controller[2] === 0xbf)

const required = REQUIRED_TESTS.filter(file => !fs.existsSync(path.join(PROJECT_ROOT, 'tests', file)))
record('Required regression suites exist', required.length === 0, required.join(', '))
if (!required.length) {
  const discovered = fs.readdirSync(path.join(PROJECT_ROOT, 'tests')).filter(file => file.endsWith('.test.mjs')).sort()
  record(`Isolated offline behavioral suites (${discovered.length})`, runRegression(discovered) === 0)
}
record('Reply cleaning compatibility', runIsolatedScript('test-clean-reply.mjs') === 0)
record('Room trigger compatibility', runIsolatedScript('test-room-trigger.mjs') === 0)
record('Controller IPC and no-side-effects smoke', runIsolatedScript('test-ui-social-ipc.mjs', ['--experimental-vm-modules']) === 0)
console.log(`\nOffline verification: ${passed} gates passed, ${failed} failed.`)
console.log('Live WeChat/Frida/Ollama/third-party service behavior and packaged GUI are separate checks; they were not run by this gate.')
process.exitCode = failed ? 1 : 0
