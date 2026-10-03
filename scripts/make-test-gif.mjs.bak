// 生成一个最小的测试 GIF（1x1 白色像素），用于打通发送链路
import fs from 'node:fs'
import path from 'node:path'

const dir = 'E:/wechaty-bot/stickers/通用'
fs.mkdirSync(dir, { recursive: true })
// 1x1 白色 GIF 的 base64
const gif = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')
const file = path.join(dir, 'test.gif')
fs.writeFileSync(file, gif)
console.log('written:', file, fs.statSync(file).size, 'bytes')
