/**
 * 微信接收图片的路径解析与 .dat 解密。
 * WeChat 3.9 收到的图片落盘为 XOR 加密的 .dat；解密思路：
 * 已知常见图片头（jpg FF D8 FF / png 89 50 4E 47 / gif 47 49 46），
 * 用首字节求出 XOR key 并校验前 3 字节一致性，然后整文件解密。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const MAGICS = [
  Buffer.from([0xff, 0xd8, 0xff]), // jpg
  Buffer.from([0x89, 0x50, 0x4e]), // png
  Buffer.from([0x47, 0x49, 0x46]), // gif
  Buffer.from([0x42, 0x4d]),       // bmp（2 字节）
]

function detectPlain(head) {
  return MAGICS.some((m) => head.subarray(0, m.length).equals(m))
}

function guessXorKey(head) {
  for (const m of MAGICS) {
    const keys = []
    for (let i = 0; i < m.length; i++) keys.push(head[i] ^ m[i])
    if (new Set(keys).size === 1) return keys[0]
  }
  return null
}

/**
 * 输入一个候选路径（.dat 或普通图片），返回可读图片的临时路径或 null。
 * 明文图片直接返回原路径；.dat 解密后写入 <原图路径>.dec.jpg 并返回。
 */
export function resolveImageFile(candidate) {
  try {
    const file = String(candidate || '')
    if (!file || !fs.existsSync(file)) return null
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return null // >20MB 不处理
    const head = Buffer.alloc(4)
    const fd = fs.openSync(file, 'r')
    fs.readSync(fd, head, 0, 4, 0)
    fs.closeSync(fd)
    if (detectPlain(head)) return file
    const key = guessXorKey(head)
    if (key === null) return null
    const data = fs.readFileSync(file)
    for (let i = 0; i < data.length; i++) data[i] ^= key
    const out = file.replace(/\.(dat|dat\.tmp)?$/i, '') + `.dec${path.extname(file).replace('.dat', '') || ''}.jpg`
    const outPath = /\.dec/.test(out) ? out : file + '.dec.jpg'
    fs.writeFileSync(outPath, data)
    return outPath
  } catch {
    return null
  }
}

/** 从 puppet-xp 图片消息的 text（JSON 数组 [thumb, thumb, extra, extra]）解析候选路径列表 */
export function parseImagePaths(messageText) {
  try {
    const arr = JSON.parse(messageText)
    if (!Array.isArray(arr)) return []
    return [...new Set(arr.map((p) => String(p || '').trim()).filter(Boolean))]
  } catch {
    return []
  }
}

// 微信数据目录自动发现：消息里的图片路径是相对路径（wxid\FileStorage\...），
// 需要拼根目录。优先 config.vision.wechatFilesRoot，否则扫描各盘常见位置。
let ROOTS = []
let discovered = false

function discoverWechatRoots() {
  if (discovered) return ROOTS
  discovered = true
  const found = []
  try {
    const drives = ['C', 'D', 'E', 'F', 'G']
    for (const d of drives) {
      // 1) 默认文档目录被重定向/自定义的情况：扫 <盘>:\Users\<用户>\Documents\WeChat Files
      const usersDir = `${d}:\\Users`
      if (!fs.existsSync(usersDir)) continue
      for (const user of fs.readdirSync(usersDir)) {
        const p = path.join(usersDir, user, 'Documents', 'WeChat Files')
        if (fs.existsSync(path.join(p, 'All Users'))) found.push(p)
      }
      // 2) 手动改过存储位置的情况：<盘>:\WeChat Files
      const custom = `${d}:\\WeChat Files`
      if (fs.existsSync(path.join(custom, 'All Users'))) found.push(custom)
    }
  } catch { /* 扫描失败就用默认 */ }
  ROOTS = found
  return ROOTS
}

/** 按候选顺序找到第一张可读图片；相对路径自动发现并尝试所有微信数据根目录 */
export function findReadableImage(candidates) {
  const roots = discoverWechatRoots()
  for (const c of candidates) {
    if (/^[a-zA-Z]:[\\/]/.test(c)) {
      const direct = resolveImageFile(c)
      if (direct) return direct
      continue
    }
    for (const root of roots) {
      const full = path.join(root, c)
      const resolved = resolveImageFile(full)
      if (resolved) return resolved
    }
  }
  return null
}

/** 图片转 base64（视觉模型入参） */
export function imageToBase64(file) {
  return fs.readFileSync(file).toString('base64')
}

/** 临时解密文件的清理句柄（可选） */
export function cleanupTemp(file) {
  try {
    if (/\.dec/.test(String(file))) fs.rmSync(file, { force: true })
  } catch {}
}

// 防止 crypto 未使用告警（保留给未来 hash 需求）
void crypto
