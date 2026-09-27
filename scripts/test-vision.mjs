// 看图说话管道测试：① dat 解密 ② 视觉模型描述本地图
// 用法：node scripts/test-vision.mjs [图片路径]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveImageFile, parseImagePaths } from '../src/image-utils.js'
import { initAi, describeImage } from '../src/ai.js'
import config from '../src/config-loader.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
initAi(config)

// ---- 1. dat 解密自测：把 test.png XOR 加密成假 .dat，再解回 ----
const png = path.join(__dirname, '..', 'stickers', 'test.png')
if (fs.existsSync(png)) {
  const data = fs.readFileSync(png)
  const key = data[0] ^ 0xff // 模拟微信加密（首字节与 jpg 头异或）
  const enc = Buffer.from(data)
  for (let i = 0; i < enc.length; i++) enc[i] ^= key
  const fakeDat = path.join(__dirname, '..', 'stickers', 'fake.dat')
  fs.writeFileSync(fakeDat, enc)
  const decrypted = resolveImageFile(fakeDat)
  const back = fs.readFileSync(decrypted || '')
  const roundTrip = back.equals(data)
  console.log(`dat 解密自测: ${roundTrip ? '✅ 还原一致' : '❌ 不一致'}`)
  fs.rmSync(fakeDat, { force: true })
  if (decrypted && /\.dec/.test(decrypted)) fs.rmSync(decrypted, { force: true })
} else {
  console.log('（跳过 dat 自测：无 test.png）')
}

// ---- 2. 模拟 puppet-xp 图片消息的 text 结构 ----
const target = process.argv[2] || path.join(__dirname, '..', 'stickers', 'test.png')
if (!fs.existsSync(target)) {
  console.error('测试图片不存在:', target)
  process.exit(1)
}
const fakeMsgText = JSON.stringify([target, target, target, target])
const candidates = parseImagePaths(fakeMsgText)
const resolved = (await import('../src/image-utils.js')).findReadableImage(candidates)
console.log(`路径解析: ${candidates.length} 个候选 -> ${resolved}`)
if (!resolved) process.exit(1)

// ---- 3. 视觉模型描述 ----
console.log(`\n调用视觉模型 ${config.vision?.model} ...`)
const t0 = Date.now()
const comment = await describeImage({ imagePath: resolved, prompt: config.vision?.prompt })
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`耗时 ${secs}s`)
console.log('视觉模型回复:', comment || '(失败)')
if (/\.dec/.test(resolved)) fs.rmSync(resolved, { force: true })
process.exit(comment ? 0 : 1)
