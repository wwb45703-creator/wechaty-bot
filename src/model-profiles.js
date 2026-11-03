/** Generation stays local. Capability metadata, not tool-call support, selects adapters. */
export function modelProfile(name, metadata = {}, ai = {}) {
  const lower = String(name || '').toLowerCase(), capabilities = metadata.capabilities || []
  const canChat = capabilities.length ? capabilities.includes('completion') : !/embed|embedding|bge-|all-minilm/i.test(lower)
  const values = metadata.thinking?.values || []
  const thinking = values.includes('low') || lower.includes('gpt-oss') ? 'low'
    : capabilities.includes('thinking') || lower.includes('qwen3') ? false : undefined
  const template = metadata.template?.trim()
  const alpaca = /mistralrp|noromaid/.test(lower) && (template === undefined || template === '{{ .Prompt }}')
  const custom = ai.modelProfiles?.[name] || {}
  return { name, canChat, capabilities, thinking, alpaca, jsonFormat: custom.jsonFormat ?? !alpaca,
    options: { temperature: ai.temperature ?? 0.75, repeat_penalty: ai.repeatPenalty ?? 1.10,
      repeat_last_n: 128, top_p: 0.9, top_k: 40, num_ctx: ai.numCtx || 8192,
      num_predict: ai.maxTokens || (thinking === 'low' ? 1024 : 160),
      ...(alpaca ? { stop: ['### Instruction:', '### Response:'] } : {}), ...(custom.options || {}) } }
}

export function adaptModelMessages(messages, profile) {
  if (!profile.alpaca) return messages
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
  // The imported GGUF has a raw {{ .Prompt }} template. Serialize all roles so
  // /api/chat cannot silently drop the persona and previous turns.
  let first = true
  const turns = messages.filter(m => m.role !== 'system').map(m => {
    if (m.role === 'assistant') return `### Response:\n${m.content}`
    const prefix = first ? `${system}\n\n` : ''; first = false
    return `### Instruction:\n${prefix}${m.content}`
  }).join('\n\n')
  return [{ role: 'user', content: `Below is an instruction that describes a task. Write a response that appropriately completes the request.\n\n${turns}\n\n### Response:\n` }]
}
