// GIF 发送链路独立测试：直接构建 sidecar 调用注入代理的 sendImageMsg
// 目标：文件传输助手（filehelper）—— 不影响真实聊天对象
// 用法：node scripts/test-sticker.mjs [图片绝对路径]
import { attach, detach } from 'sidecar'
import { WeChatSidecar } from '../node_modules/wechaty-puppet-xp/dist/esm/src/wechat-sidecar.js'
import fs from 'node:fs'

const target = process.argv[2] || 'filehelper'
const img = process.argv[3] || 'E:/wechaty-bot/stickers/通用/test.gif'

if (!fs.existsSync(img)) {
  console.error('测试图片不存在:', img)
  process.exit(1)
}
console.log(`目标: ${target}  图片: ${img}`)

const sidecar = new WeChatSidecar()
try {
  await attach(sidecar)
  console.log('agent 已注入，等待 2 秒稳定...')
  await new Promise((r) => setTimeout(r, 2000))

  const self = await sidecar.getMyselfInfo()
  console.log('登录状态探测 selfInfo:', JSON.stringify(self))
  if (!self || !self.id) {
    console.error('微信尚未登录（或未就绪），请先在微信窗口完成登录后再测')
    process.exit(1)
  }

  const success = await sidecar.sendPicMsg(target, img)
  console.log('sendPicMsg 返回:', success)
  console.log('等待 8 秒观察微信是否存活（图片发送是异步的，不能马上 detach）...')
  await new Promise((r) => setTimeout(r, 8000))
  console.log('等待结束')
}
catch (err) {
  console.error('发送失败:', err?.stack || err)
  process.exitCode = 1
}
finally {
  try { await detach(sidecar) } catch {}
}
