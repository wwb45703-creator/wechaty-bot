/**
 * AI 连通性自测（不依赖微信）：
 *   node src/test-ai.js "你好"
 * 输出 Ollama 的回复则说明大脑就绪。
 */
import config from './config-loader.js'
import { initAi, chat } from './ai.js'
import { logger } from './logger.js'

initAi(config)

const q = process.argv[2] || '用一句话介绍一下你自己'
logger.info(`测试 Ollama (${config.ai.baseUrl}) 模型 ${config.ai.model}，问题：${q}`)

const reply = await chat({ key: 'test', userText: q })
if (reply) {
  console.log('\n===== AI 回复 =====')
  console.log(reply)
  console.log('===== 测试通过 =====\n')
} else {
  console.error('AI 未回复。请检查：1) Ollama 是否在运行（ollama list）2) config.json 里的模型名是否存在')
  process.exit(1)
}
