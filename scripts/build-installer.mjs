/** Reproducible offline payload; never reads production config or starts services. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a value`)
  return args[index + 1]
}
const known = new Set(['--out', '--runtime-source', '--ollama-source', '--stage-only', '--reuse-stage'])
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i])) throw new Error(`Unknown option: ${args[i]}`)
  if (['--out', '--runtime-source', '--ollama-source'].includes(args[i])) i++
}
const output = path.resolve(option('--out', process.env.BOT_INSTALLER_OUTPUT || 'E:\\微信机器人安装包\\2026-10-30'))
const runtimeSource = path.resolve(option('--runtime-source', 'D:\\wechaty-bot'))
const ollamaSource = path.resolve(option('--ollama-source', 'D:\\Ollama'))
if (process.platform !== 'win32') throw new Error('This release requires Windows x64 and its installed native dependencies')
if (!/^E:\\/i.test(output)) throw new Error('Installer output must be under E:\\ to keep large artifacts off the system/project drive')
if (path.parse(output).root === output) throw new Error('Choose a dedicated output folder, not a drive root')
const stage = path.join(output, '.stage')
const resources = path.join(stage, 'resources')
const payload = path.join(resources, 'bot-runtime')
const manifestFile = path.join(output, 'payload-manifest.json')
const ownerFile = path.join(stage, 'stage.owner.json')
const owner = 'wechaty-bot-offline-installer-v1'
const excluded = new Set(['.mimosa', '.git', '.svn', '.cache', '.npm', '__pycache__', '.DS_Store', '.package-lock.json'])
let filesCopied = 0, bytesCopied = 0

function assertInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Refusing unsafe stage path: ${child}`)
}
function assertOwnedStageTarget() {
  const realOutput = fs.realpathSync(output)
  if (!/^E:\\/i.test(realOutput)) throw new Error('Output resolves outside E:\\; preserving it')
  for (const target of [stage, resources]) {
    if (!fs.existsSync(target)) continue
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing a linked stage target: ${target}`)
    assertInside(fs.realpathSync(target), realOutput)
  }
}
function run(exe, argv, options = {}) {
  const result = spawnSync(exe, argv, { windowsHide: true, stdio: 'inherit', ...options })
  if (result.error || result.status !== 0) throw result.error || new Error(`${path.basename(exe)} exited ${result.status}`)
}
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8') }
function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  filesCopied++; bytesCopied += fs.statSync(target).size
}
function copyTree(source, target, boundary = fs.realpathSync(source)) {
  const base = path.basename(source)
  if (excluded.has(base) || (base.startsWith('.') && base !== '.bin') || /\.(?:log|tmp)$/i.test(base)) return
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    const real = fs.realpathSync(source)
    const relative = path.relative(boundary, real)
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Dependency link escapes its source: ${source}`)
    return copyTree(real, target, boundary)
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(source)) copyTree(path.join(source, entry), path.join(target, entry), boundary)
  } else if (stat.isFile()) copyFile(source, target)
}
function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Release trees must contain regular files, not links: ${name}`)
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), name) : [{ path: name, bytes: fs.statSync(path.join(dir, entry.name)).size }]
  }).sort((a, b) => a.path.localeCompare(b.path))
}
async function sha256(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
async function hashFiles(rows, base) {
  let next = 0
  const result = new Array(rows.length)
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < rows.length) {
      const index = next++, row = rows[index]
      result[index] = { ...row, sha256: await sha256(path.join(base, row.path)) }
    }
  }))
  return result
}
function sourceFingerprint() {
  const hash = crypto.createHash('sha256')
  const names = [
    ...listFiles(path.join(project, 'src')).filter(row => !row.path.split('/').some(part => excluded.has(part) || part.startsWith('.')) && !/\.(?:log|tmp)$/i.test(row.path)).map(row => `src/${row.path}`),
    'package.json', 'config.example.json', 'scripts/installed-control.ps1', 'scripts/installed-launcher.vbs',
  ]
  for (const name of names.sort()) hash.update(name).update('\0').update(fs.readFileSync(path.join(project, name)))
  return hash.digest('hex')
}
function getVersion(file) { return JSON.parse(fs.readFileSync(file, 'utf8')).version }
function stageOllamaLicense() {
  const expectedBlob = '8e3dc978a7ca8c53f56bbedc5b558116140fc02e'
  const cached = path.join(output, '.sources', 'ollama-v0.34.4-LICENSE')
  let bytes
  if (fs.existsSync(cached)) bytes = fs.readFileSync(cached)
  else {
    const result = spawnSync('gh', ['api', 'repos/ollama/ollama/contents/LICENSE?ref=v0.34.4'], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
    if (result.status !== 0) throw new Error('Cannot fetch the fixed Ollama v0.34.4 MIT license from its official repository')
    const source = JSON.parse(result.stdout)
    if (source.sha !== expectedBlob) throw new Error('Unexpected Ollama license revision')
    bytes = Buffer.from(source.content, 'base64')
  }
  const blob = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (blob !== expectedBlob) throw new Error('Ollama license cache is corrupt')
  fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, bytes)
  copyFile(cached, path.join(payload, 'runtime', 'ollama', 'LICENSE'))
  return { version: 'v0.34.4', source: 'https://github.com/ollama/ollama/blob/v0.34.4/LICENSE', gitBlob: blob, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
}
function assertPayload() {
  const required = [
    'src/index.js', 'src/social/index.js', 'src/skills/review-store.js', 'package.json',
    'config.defaults.json', 'distribution.json', 'runtime/node18/node.exe', 'runtime/node18/LICENSE',
    'runtime/ollama/ollama.exe', 'runtime/ollama/LICENSE', 'runtime/ollama/lib/ollama/LLAMA_CPP_LICENSE',
    'node_modules/frida/build/Release/frida_binding.node',
    'node_modules/wechaty-puppet-xp/dist/esm/src/init-agent-script.js',
    'node_modules/wechaty-puppet-xp/dist/cjs/src/init-agent-script.js',
    'scripts/installed-control.ps1', 'scripts/installed-launcher.vbs',
  ]
  for (const file of required) if (!fs.existsSync(path.join(payload, file))) throw new Error(`Missing runtime dependency: ${file}`)
  for (const dir of ['config.json', 'memories', 'state', 'logs', 'data']) if (fs.existsSync(path.join(payload, dir))) throw new Error(`Private data must not enter payload: ${dir}`)
  for (const file of listFiles(resources)) {
    const parts = file.path.split('/')
    if (parts.some(part => part.startsWith('.') && part !== '.bin') || /(?:^|\/)(?:credentials|secrets?)(?:\.(?:json|ya?ml|toml|env|key|pem))?$/i.test(file.path)) throw new Error(`Private or hidden metadata entered the payload: ${file.path}`)
  }
  if (!fs.existsSync(path.join(resources, 'prerequisites', 'WeChatSetup-3.9.10.27.exe'))) throw new Error('The version-pinned WeChat prerequisite is missing')
}

async function ensureNsisTool(cache, name, version, expected) {
  const target = path.join(cache, name, `${name}-${version}`)
  if (fs.existsSync(target) && fs.readdirSync(target).length) return
  const tag = `${name}-${version}`, assetName = `${tag}.7z`
  const archive = path.join(cache, assetName)
  if (!fs.existsSync(archive) || crypto.createHash('sha512').update(fs.readFileSync(archive)).digest('base64') !== expected) {
    console.log(`Fetching official pinned build tool ${tag} through GitHub API ...`)
    const release = spawnSync('gh', ['api', `repos/electron-userland/electron-builder-binaries/releases/tags/${tag}`], { windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
    if (release.status !== 0) throw new Error(`Cannot read official ${tag} release; use a pre-populated builder cache. ${release.error?.message || release.stderr || ''}`)
    const asset = JSON.parse(release.stdout).assets.find(item => item.name === assetName)
    if (!asset) throw new Error(`Official ${tag} archive not found`)
    const downloaded = spawnSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/electron-userland/electron-builder-binaries/releases/assets/${asset.id}`], { windowsHide: true, timeout: 120000, maxBuffer: 100 * 1024 * 1024 })
    if (downloaded.status !== 0) throw new Error(`Official ${tag} download failed: ${downloaded.error?.message || downloaded.stderr?.toString() || ''}`)
    if (crypto.createHash('sha512').update(downloaded.stdout).digest('base64') !== expected) throw new Error(`Official ${tag} checksum mismatch; refusing to execute build tools`)
    fs.writeFileSync(archive, downloaded.stdout)
  }
  const extracting = `${target}.extract-${process.pid}`
  assertInside(extracting, cache)
  fs.mkdirSync(extracting, { recursive: true })
  try {
    run(path.join(project, 'ui', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'), ['x', archive, `-o${extracting}`, '-y'])
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) fs.rmdirSync(target)
    fs.renameSync(extracting, target)
  } finally { fs.rmSync(extracting, { recursive: true, force: true }) }
}

fs.mkdirSync(output, { recursive: true })
assertOwnedStageTarget()
if (!args.includes('--reuse-stage')) {
  const fingerprintAtStart = sourceFingerprint()
  for (const file of [path.join(runtimeSource, 'runtime', 'node18', 'node.exe'), path.join(ollamaSource, 'ollama.exe'), path.join(runtimeSource, 'downloads', 'WeChatSetup-3.9.10.27.exe')]) if (!fs.existsSync(file)) throw new Error(`Required local source is missing: ${file}`)
  if (fs.existsSync(stage)) {
    if (!fs.existsSync(ownerFile) || JSON.parse(fs.readFileSync(ownerFile, 'utf8')).owner !== owner) throw new Error('Existing stage is not owned by this builder; preserving it')
    assertOwnedStageTarget()
    assertInside(resources, output)
    fs.rmSync(resources, { recursive: true, force: true })
  }
  fs.mkdirSync(stage, { recursive: true })
  writeJson(ownerFile, { owner })
  console.log('Staging source, patched dependencies and bundled runtimes on E: ...')
  copyTree(path.join(project, 'src'), path.join(payload, 'src'))
  copyFile(path.join(project, 'package.json'), path.join(payload, 'package.json'))
  copyTree(path.join(runtimeSource, 'node_modules'), path.join(payload, 'node_modules'))
  for (const file of ['node.exe', 'LICENSE']) copyFile(path.join(runtimeSource, 'runtime', 'node18', file), path.join(payload, 'runtime', 'node18', file))
  copyFile(path.join(ollamaSource, 'ollama.exe'), path.join(payload, 'runtime', 'ollama', 'ollama.exe'))
  const ollamaLicense = stageOllamaLicense()
  const ollamaLib = path.join(ollamaSource, 'lib', 'ollama')
  for (const entry of fs.readdirSync(ollamaLib, { withFileTypes: true })) if (entry.isFile() || ['cuda_v12', 'cuda_v13'].includes(entry.name)) copyTree(path.join(ollamaLib, entry.name), path.join(payload, 'runtime', 'ollama', 'lib', 'ollama', entry.name))
  for (const file of ['installed-control.ps1', 'installed-launcher.vbs']) copyFile(path.join(project, 'scripts', file), path.join(payload, 'scripts', file))
  copyFile(path.join(runtimeSource, 'downloads', 'WeChatSetup-3.9.10.27.exe'), path.join(resources, 'prerequisites', 'WeChatSetup-3.9.10.27.exe'))
  const defaults = JSON.parse(fs.readFileSync(path.join(project, 'config.example.json'), 'utf8'))
  defaults.private = { ...(defaults.private || {}), enabled: false, whitelist: [] }
  defaults.rooms = []; defaults.proactive = []
  defaults.welcome = { ...(defaults.welcome || {}), enabled: false }
  defaults.astrbot = { enabled: false }
  defaults.ai = { ...(defaults.ai || {}), baseUrl: 'http://127.0.0.1:11434', provider: 'ollama' }
  defaults.reach ||= {}; defaults.reach.search = { ...(defaults.reach.search || {}), implicit: false }
  writeJson(path.join(payload, 'config.defaults.json'), defaults)
  writeJson(path.join(payload, 'distribution.json'), {
    format: 1, kind: 'wechaty-bot-offline', version: '1.2.0', architecture: 'x64',
    node: '18.20.8', wechat: '3.9.10.27', puppetXp: getVersion(path.join(runtimeSource, 'node_modules', 'wechaty-puppet-xp', 'package.json')),
    modelsIncluded: false, ollamaBackends: ['cpu', 'cuda_v12', 'cuda_v13'],
    licenses: { ollama: ollamaLicense },
  })
  assertPayload()
  console.log('Hashing the complete staged payload ...')
  const files = await hashFiles(listFiles(resources), resources)
  const important = files.filter(row => /(?:\.node$|\/node\.exe$|\/ollama\.exe$|\/init-agent-script\.js$|WeChatSetup-|distribution\.json$|config\.defaults\.json$)/.test(row.path))
  if (sourceFingerprint() !== fingerprintAtStart) throw new Error('Runtime source changed during staging; rerun stage after editing completes')
  writeJson(manifestFile, { format: 1, version: '1.2.0', generatedAt: new Date().toISOString(), sourceFingerprint: fingerprintAtStart, fileCount: files.length, bytes: files.reduce((sum, row) => sum + row.bytes, 0), hashes: important, files })
  console.log(JSON.stringify({ staged: true, fileCount: files.length, copiedFiles: filesCopied, bytes: bytesCopied, manifest: manifestFile }, null, 2))
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (manifest.sourceFingerprint !== sourceFingerprint()) throw new Error('Source changed since staging; run --stage-only again before building')
  assertPayload()
  const inventory = listFiles(resources)
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.files.map(({ path: name, bytes }) => ({ path: name, bytes })))) throw new Error('Staged payload inventory changed; restage before building')
  const verified = await hashFiles(inventory, resources)
  if (verified.some((row, index) => row.sha256 !== manifest.files[index].sha256)) throw new Error('Staged payload content changed; restage before building')
  console.log(`Reusing staged offline payload (${manifest.fileCount} files)`)
}
if (args.includes('--stage-only')) process.exit(0)

const cache = path.join(output, '.build-cache')
const temp = path.join(output, '.build-temp')
fs.mkdirSync(cache, { recursive: true }); fs.mkdirSync(temp, { recursive: true })
// Reuse already installed signing helpers while keeping all new downloads on E:.
const oldCache = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'winCodeSign')
if (oldCache && fs.existsSync(oldCache) && !fs.existsSync(path.join(cache, 'winCodeSign'))) copyTree(oldCache, path.join(cache, 'winCodeSign'))
await ensureNsisTool(cache, 'nsis', '3.0.4.1', 'VKMiizYdmNdJOWpRGz4trl4lD++BvYP2irAXpMilheUP0pc93iKlWAoP843Vlraj8YG19CVn0j+dCo/hURz9+Q==')
await ensureNsisTool(cache, 'nsis-resources', '3.4.1', 'Dqd6g+2buwwvoG1Vyf6BHR1b+25QMmPcwZx40atOT57gH27rkjOei1L0JTldxZu4NFoEmW4kJgZ3DlSWVON3+Q==')
const buildNode = fs.existsSync('D:\\node.js\\node.exe') ? 'D:\\node.js\\node.exe' : process.execPath
run(buildNode, [path.join(project, 'ui', 'node_modules', 'electron-builder', 'cli.js'), '--projectDir', path.join(project, 'ui'), '--config', path.join(project, 'ui', 'installer.config.cjs'), '--win', 'nsis', '--x64', '--publish', 'never', `--config.electronDist=${path.join(project, 'ui', 'node_modules', 'electron', 'dist')}`], {
  cwd: project,
  env: { ...process.env, BOT_INSTALLER_OUTPUT: output, BOT_INSTALLER_STAGE: resources, ELECTRON_BUILDER_CACHE: cache,
    ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || '3', TEMP: temp, TMP: temp },
})
const buildDir = path.join(output, 'build')
const installers = fs.readdirSync(buildDir).filter(name => /^WechatyBotConsole-Setup-1\.2\.0-x64\.exe$/.test(name))
if (installers.length !== 1) throw new Error('Expected exactly one offline installer')
for (const name of installers) {
  const source = path.join(buildDir, name), target = path.join(output, name)
  copyFile(source, target)
  fs.writeFileSync(path.join(output, `${name}.sha256`), `${await sha256(target)}  ${name}\n`, 'utf8')
  console.log(JSON.stringify({ installer: target, bytes: fs.statSync(target).size, sha256: await sha256(target) }))
}
copyFile(path.join(project, 'docs', 'INSTALLER.md'), path.join(output, '安装与依赖说明.md'))
