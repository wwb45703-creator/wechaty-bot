import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-image-compat-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
process.env.BOT_TEST_MODE = '1'
const imageRoot = path.join(root, 'wechat-files')
fs.mkdirSync(imageRoot)
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ vision: { wechatFilesRoot: imageRoot } }))
const { resolveImageFile, parseImagePaths, findReadableImage, cleanupTemp } = await import('../src/image-utils.js')
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

test('received dat files decode with the correct XOR key; existing plain images are not overwritten', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const plain = path.join(imageRoot, 'plain.png')
  fs.writeFileSync(plain, png)
  assert.equal(resolveImageFile(plain), plain)
  assert.deepEqual(fs.readFileSync(plain), png)
  const encrypted = path.join(imageRoot, 'fixture.dat')
  fs.writeFileSync(encrypted, Buffer.from(png.map(value => value ^ 0xaa)))
  const decoded = resolveImageFile(encrypted)
  assert.ok(decoded.startsWith(root + path.sep))
  assert.deepEqual(fs.readFileSync(decoded), png)
  cleanupTemp(decoded)
  assert.equal(fs.existsSync(decoded), false)
  assert.equal(fs.existsSync(encrypted), true)
})

test('image metadata parsing and configured relative root work without scanning user directories', () => {
  assert.deepEqual(parseImagePaths('["a.dat","a.dat","b.dat",""]'), ['a.dat', 'b.dat'])
  assert.deepEqual(parseImagePaths('invalid'), [])
  assert.equal(resolveImageFile(path.join(root, 'missing.dat')), null)
  const plain = path.join(imageRoot, 'relative.png')
  fs.writeFileSync(plain, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  assert.equal(findReadableImage(['relative.png']), plain)
})
