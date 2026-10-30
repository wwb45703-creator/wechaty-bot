function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error('模型任务已取消或超时'))
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('模型任务已取消或超时'))
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

/** ModelProvider: local inference only. Cloud adapters must be explicitly added later. */
export function createOllamaProvider(config = {}, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const ai = config.ai || config
  const base = new URL(ai?.baseUrl || 'http://127.0.0.1:11434')
  if (!['http:', 'https:'].includes(base.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) {
    throw new Error('本地模式只允许环回地址上的 Ollama；云端适配尚未启用')
  }
  if (ai?.provider && ai.provider !== 'ollama') throw new Error('当前仅启用 Ollama provider')
  return {
    name: 'ollama',
    async generate({ messages, model = ai?.model, options = {}, signal, timeoutMs, keepAlive } = {}) {
      if (!Array.isArray(messages) || !model) throw new Error('缺少模型或 messages')
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) abort()
      signal?.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(), timeoutMs || (ai?.timeoutSeconds || 180) * 1000)
      try {
        if (controller.signal.aborted) throw new Error('模型任务已取消')
        const res = await abortable(fetchImpl(new URL('/api/chat', base), {
          method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model, messages, stream: false, think: false,
            keep_alive: keepAlive ?? ai?.keepAlive ?? '2h',
            options: { temperature: ai?.temperature ?? 0.8, repeat_penalty: 1.18,
              presence_penalty: 0.4, frequency_penalty: 0.3, ...options },
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
