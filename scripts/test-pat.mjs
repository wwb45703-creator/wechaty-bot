// 拍一拍隔离测试：让机器人拍自己（需传入群ID和wxid，不内置任何真实账号数据）
// 用法：node scripts/test-pat.mjs <群ID@chatroom> <要拍的wxid>
import { attach, detach } from 'sidecar'
import { WeChatSidecar } from '../node_modules/wechaty-puppet-xp/dist/esm/src/wechat-sidecar.js'

const ROOM = process.argv[2]
const SELF = process.argv[3] || ROOM ? process.argv[3] : null

if (!ROOM || !SELF) {
  console.error('用法: node scripts/test-pat.mjs <群ID@chatroom> <要拍的wxid>')
  console.error('建议用机器人自己的 wxid 测试（拍自己最安全）')
  process.exit(1)
}

const sidecar = new WeChatSidecar()
sidecar.on('error', (e) => console.log('[sidecar error 事件]:', e?.description || e?.message || e))
try {
  await attach(sidecar)
  await new Promise((r) => setTimeout(r, 2000))
  console.log(`拍一拍调用中...`)
  await sidecar.patMsg(ROOM, SELF)
  await new Promise((r) => setTimeout(r, 3000))
  console.log('调用完成')
}
catch (err) {
  console.error('拍一拍失败:', err?.stack || err)
  process.exitCode = 1
}
finally {
  try { await detach(sidecar) } catch {}
}
