// 生成一张正规的 64x64 纯色 PNG 测试图（零依赖，用 zlib 手工编码）
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const dir = 'E:/wechaty-bot/stickers/通用'
fs.mkdirSync(dir, { recursive: true })

const W = 64, H = 64
// RGB 扫描行，每行前加 filter byte 0
const raw = Buffer.alloc(H * (1 + W * 3))
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * (1 + W * 3) + 1 + x * 3
    raw[i] = 0x41; raw[i + 1] = 0xa1; raw[i + 2] = 0xe4 // 天蓝色
  }
}
const idat = zlib.deflateSync(raw)

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcInput = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcInput) >>> 0)
  return Buffer.concat([len, typeBuf, data, crc])
}
let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let crc = 0xFFFFFFFF
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return crc ^ 0xFFFFFFFF
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
])
const file = path.join(dir, 'test.png')
fs.writeFileSync(file, png)
console.log('written:', file, fs.statSync(file).size, 'bytes')
