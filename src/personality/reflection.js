/**
 * reflection.js — 记忆驱动人格演化反哺引擎
 *
 * 核心职责：
 *  1. 全场景打通：私聊好友与多个群聊沉淀的长期记忆（语义事实 + 情景经历）全量汇流
 *  2. 记忆反哺演化：自动从提取出的事实中提炼话题兴趣与情感倾向，驱动五维性格演变与动态爱好确立
 *  3. 安全防操纵：继承防注入检查与单人单日权重上限
 *  4. 隐私安全隔离：记忆具体事实仅留存于个人记忆文件，反哺给机器人的仅是抽象性格倾向与公开兴趣池
 */

import { recordEvolutionEvent, isManipulationAttempt } from './persona-state.js'

/**
 * 常见领域关键词映射表（用于抽象爱好归纳与性格侧重）
 */
const TOPIC_PATTERNS = [
  { topic: '技术编程', pattern: /(代码|编程|python|node|js|vue|react|bug|api|linux|服务器|前端|后端|算法|数据库|sql|docker|git)/i },
  { topic: '人工智能与大模型', pattern: /(大模型|ai|ollama|llm|agent|gpt|prompt|神经网络|深度学习|权重|微调|lora)/i },
  { topic: '二次元动漫', pattern: /(番剧|二次元|动漫|cos|漫画|新番|轻小说|手办|漫展|声优|acg)/i },
  { topic: '游戏娱乐', pattern: /(原神|绝区零|崩铁|王者|游戏|steam|打瓦|瓦罗兰特|黑神话|掌机|主机|单机)/i },
  { topic: '科学探索', pattern: /(物理|量子|天文|数学|科学|生物|宇宙|化学|论文)/i },
  { topic: '美食烹饪', pattern: /(美食|做饭|做菜|烘焙|蛋糕|面包|咖啡|烹饪|烤箱|好吃|探店)/i },
  { topic: '音乐与艺术', pattern: /(音乐|吉他|钢琴|唱歌|画画|板绘|插画|设计|美术|编曲)/i },
  { topic: '运动与户外', pattern: /(运动|健身|跑步|羽毛球|骑行|徒步|登山|篮球|足球)/i },
]

/**
 * 从文本或记忆要点中提取核心兴趣主题
 */
export function detectTopics(textList) {
  const combined = (Array.isArray(textList) ? textList.join(' ') : String(textList || '')).toLowerCase()
  const detected = new Set()

  for (const { topic, pattern } of TOPIC_PATTERNS) {
    if (pattern.test(combined)) {
      detected.add(topic)
    }
  }

  // 针对特定专业名词的细粒度捕捉（如“烘焙面包”、“量子计算”）
  const specificMatch = combined.match(/(量子计算|烘焙面包|逆向工程|嵌入式开发|胶片摄影|模型制作)/)
  if (specificMatch) {
    detected.add(specificMatch[1])
  }

  return Array.from(detected)
}

/**
 * 从记忆要点与情景互动中反哺人格演化
 * @param {object} p
 * @param {string} p.userId
 * @param {string} [p.displayName]
 * @param {string} [p.roomId]
 * @param {string[]} [p.facts] 提取出的长期语义事实列表
 * @param {object} [p.episode] 产生的情景记忆对象 { description, importance, emotionalTag }
 * @param {string} [p.source] 来源渠道：'private' (私聊) | 'room' (群聊)
 */
export async function reflectOnMemories({ userId, displayName = '', roomId = '', facts = [], episode = null, source = 'private' }) {
  if (!userId) return

  // 收集本次提取到的所有记忆文本
  const texts = [...(facts || [])]
  if (episode && episode.description) {
    texts.push(episode.description)
  }
  if (texts.length === 0) return

  // 1. 防操纵安全检测：如果事实中包含恶意指令注入，严禁污染人格
  for (const t of texts) {
    if (isManipulationAttempt(t)) {
      return
    }
  }

  // 2. 识别记忆中涉及的主题
  const topics = detectTopics(texts)

  // 3. 记忆权重因数计算
  // 私聊深入对话或高重要性情景记忆拥有更真实的反哺权重
  const baseWeight = source === 'private' ? 0.6 : 0.4
  const importanceMultiplier = episode ? Math.max(1, episode.importance / 5) : 1
  const finalWeight = Math.min(1.0, baseWeight * importanceMultiplier)

  // 4. 推动动态爱好的沉淀与生长
  for (const topic of topics) {
    recordEvolutionEvent({
      eventType: 'deep_discussion',
      weight: finalWeight,
      topic,
      reason: `从${source === 'private' ? '私聊深度交流' : '群聊互动'}中沉淀记忆，关注到[${topic}]`,
      userId,
      roomId,
    })
  }

  // 5. 情感与性格反哺
  // 分析记忆中的互动正负向反馈
  const allContent = texts.join(' ')
  const isHelpful = episode?.emotionalTag === 'helpful' || /(指导|帮助|教会|协助|解答|分享经验)/.test(allContent)
  const isPositive = /(喜欢|热爱|擅长|开心|有趣|佩服|认可)/.test(allContent)
  const isConflict = /(争执|反驳|生气|不满|吐槽)/.test(allContent)

  if (isHelpful) {
    // 用户热心帮助或分享深层经验 -> 提升信任倾向与外向性
    recordEvolutionEvent({
      eventType: 'friendly_interaction',
      weight: 0.5,
      reason: `群友或私聊好友提供了有益经验与协助 (${source})`,
      userId,
      roomId,
    })
  } else if (isPositive) {
    recordEvolutionEvent({
      eventType: 'positive_response',
      weight: 0.4,
      reason: `交流中沉淀了积极共鸣的长期记忆 (${source})`,
      userId,
      roomId,
    })
  } else if (isConflict) {
    recordEvolutionEvent({
      eventType: 'negative_feedback',
      weight: 0.4,
      reason: `经历微弱冲突或争议事实，性格调整为适度谨慎 (${source})`,
      userId,
      roomId,
    })
  }
}
