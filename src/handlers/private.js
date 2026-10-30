import { processMessage } from '../messaging.js'
import { produceTextResponse, isForgetCommand, isAllForget } from './text-response.js'

export async function handlePrivateMessage(msg, admission = null) {
  const text = String(msg.text?.() || '').trim()
  if (!text) return
  return processMessage({ msg, admission, kind: 'text', forget: isForgetCommand(text), allConversations: isAllForget(text),
    producer: (ctx) => produceTextResponse(ctx, text) })
}
