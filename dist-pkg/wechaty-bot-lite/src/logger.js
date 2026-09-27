import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const logDir = path.join(__dirname, '..', 'logs')
fs.mkdirSync(logDir, { recursive: true })

function append(line) {
  const file = path.join(logDir, `bot-${new Date().toISOString().slice(0, 10)}.log`)
  try {
    fs.appendFileSync(file, line + '\n', 'utf8')
  } catch {
    /* 日志写入失败不影响主流程 */
  }
}

function stamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

function emit(level, args) {
  const line = `[${stamp()}] [${level}] ${args.map(String).join(' ')}`
  if (level === 'ERROR') console.error(line)
  else console.log(line)
  append(line)
}

export const logger = {
  info: (...args) => emit('INFO', args),
  warn: (...args) => emit('WARN', args),
  error: (...args) => emit('ERROR', args),
}
