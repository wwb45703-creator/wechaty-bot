// 诊断：反汇编对比发送相关函数的入口指令，判断 offset 表正确性
import { attach, detach } from 'sidecar'
import { WeChatSidecar } from '../node_modules/wechaty-puppet-xp/dist/esm/src/wechat-sidecar.js'

const sidecar = new WeChatSidecar()
try {
  await attach(sidecar)
  await new Promise((r) => setTimeout(r, 2000))
  const result = await sidecar.probeOffsets()
  console.log(JSON.stringify(result, null, 2))
}
catch (err) {
  console.error('探测失败:', err?.stack || err)
  process.exitCode = 1
}
finally {
  try { await detach(sidecar) } catch {}
}
