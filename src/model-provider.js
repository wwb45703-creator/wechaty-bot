import { modelProfile, adaptModelMessages } from './model-profiles.js'

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error('模型任务已取消或超时'))
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('模型任务已取消或超时'))
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

/** ModelProvider: local inference only. Cloud adapters must be explicitly added later. */
export function createOllamaProvider(config = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || ((...args) => fetch(...args))
  const inspectModels = dependencies.inspectModels ?? !dependencies.fetchImpl
  const metadata = new Map()
  const ai = config.ai || config
  const base = new URL(ai?.baseUrl || 'http://127.0.0.1:11434')
  if (!['http:', 'https:'].includes(base.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw new Error('本地模式只允许环回地址上的 Ollama；云端适配尚未启用')
  }
  if (ai?.provider && ai.provider !== 'ollama') throw new Error('当前仅启用 Ollama provider')
  return {
    name: 'ollama',
    async generate({ messages, model = ai?.model, options = {}, signal, timeoutMs, keepAlive, format } = {}) {
      if (!Array.isArray(messages) || !model) throw new Error('缺少模型或 messages')
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) abort()
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(), timeoutMs || (ai?.timeoutSeconds || 180) * 1000)
      try {
        if (controller.signal.aborted) throw new Error('模型任务已取消')
        if (inspectModels && (!metadata.has(model) || metadata.get(model).expires < Date.now())) {
          const show = await abortable(fetchImpl(new URL('/api/show', base), { method: 'POST', redirect: 'error', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }), controller.signal)
          if (!show.ok || show.redirected) throw new Error(`无法读取模型能力：Ollama HTTP ${show.status}`)
          metadata.set(model, { value: await abortable(show.json(), controller.signal), expires: Date.now() + 300000 })
        }
        const profile = modelProfile(model, metadata.get(model)?.value, ai)
        if (!profile.canChat) throw Object.assign(new Error('该模型仅支持嵌入，不能用于聊天'), { code: 'MODEL_NOT_CHAT' })
        const res = await abortable(fetchImpl(new URL('/api/chat', base), {
          method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, messages: adaptModelMessages(messages, profile), stream: false,
            ...(profile.thinking === undefined ? {} : { think: profile.thinking }),
            ...(format === undefined || !profile.jsonFormat ? {} : { format }),
            keep_alive: keepAlive ?? ai?.keepAlive ?? '2h',
            options: { ...profile.options, ...options },
          }),
        }), controller.signal)
        if (res.redirected) throw new Error('本地模型禁止重定向')
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)
        const data = await abortable(res.json(), controller.signal)
        if (controller.signal.aborted) throw new Error('模型任务已取消')
        return { text: String(data?.message?.content || ''), provider: 'ollama', model,
          usage: { inputTokens: data?.prompt_eval_count || 0, outputTokens: data?.eval_count || 0 } }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
    },
  }
}
