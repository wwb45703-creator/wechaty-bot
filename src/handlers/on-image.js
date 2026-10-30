import config from '../config-loader.js'
import { describeImage } from '../ai.js'
import { processMessage, waitForDelay } from '../messaging.js'
import { parseImagePaths, findReadableImage, cleanupTemp } from '../image-utils.js'

export function isVisionEnabled() { return config.vision?.enabled !== false }
export async function handleImageMessage(msg, room, admission = null) {
  if (!isVisionEnabled()) return
  return processMessage({ msg, room, admission, kind: 'image', producer: async (ctx) => {
    const candidates = parseImagePaths(msg.text?.() || '')
    let imageFile
    for (const delay of [0, 800, 2000, 4000]) {
      if (ctx.signal.aborted) return null
      if (delay) await waitForDelay(delay, ctx.signal)
      imageFile = findReadableImage(candidates)
      if (imageFile) break
    }
    if (!imageFile) return null
    try {
      const text = await describeImage({ imagePath: imageFile, prompt: config.vision?.prompt || '用一两句自然口语回应图片，不确定时如实说明',
        personaName: ctx.scope.personaId, scope: ctx.scope, epoch: ctx.epoch, signal: ctx.signal })
      return { text, userText: '分享了一张图片', extract: false, learn: Boolean(text) }
    } finally { cleanupTemp(imageFile) }
  } })
}
