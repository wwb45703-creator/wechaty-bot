/**
 * 晨间热点早报聚合器（免大模型，纯本地轻量排版）
 * 复用现有的 webSearch 抓取当日热点资讯，并结合东八区日期自动排版。
 */

import { webSearch } from './search.js'
import { logger } from '../logger.js'

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 获取当前东八区日期的中文友好格式 */
export function getShanghaiDateStr() {
  const now = new Date()
  const dStr = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' })
  // 计算东八区当前星期几
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  const shanghaiTime = new Date(utc + 8 * 3600000)
  const weekday = WEEKDAYS[shanghaiTime.getDay()]
  return `${dStr} ${weekday}`
}

/**
 * 生成今日热点早报
 * @param {string} [customGreeting] 自定义问候语前缀
 * @returns {Promise<string>} 排版好的早报文本
 */
export async function generateMorningBrief(customGreeting = '早上好！', options = {}) {
  const dateStr = getShanghaiDateStr()
  try {
    const res = await webSearch('今日国内要闻', { numResults: 5, signal: options.signal, deadline: options.deadline })
    const items = res?.results || []
    if (!items.length) {
      return `☀️ ${customGreeting}今天是 ${dateStr}，祝大家今天都有好心情！`
    }

    const lines = items.slice(0, 5).map((item, index) => {
      // 清洗掉标题末尾的网站后缀如 "_网易新闻" 或 "- 环球网"
      const cleanTitle = item.title.replace(/[\s\-_\|][^\-_\|]+(?:网|频道|客户端|早报|要闻)$/i, '').trim()
      return `${index + 1}. ${cleanTitle}`
    })

    return [
      `☀️ ${customGreeting}今天是 ${dateStr}`,
      '━━━━━━━━━━━━━━',
      '🔥 【今日热点早报】',
      ...lines,
      '━━━━━━━━━━━━━━',
      '祝大家工作/学习顺利，开启元气满满的一天！'
    ].join('\n')
  } catch (err) {
    logger.warn(`[morning-brief] 热点早报生成降级: ${err.message}`)
    return `☀️ ${customGreeting}今天是 ${dateStr}，祝大家今天都有好心情！`
  }
}
