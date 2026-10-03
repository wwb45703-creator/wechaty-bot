/**
 * 零闪窗子进程封装：reach 层所有外部 CLI（yt-dlp / mcporter / python / gh）统一走这里。
 *
 * 约定（延续零闪窗改造）：
 *  - windowsHide: true（Windows 下不创建控制台窗口）
 *  - stdio 全部管道，不继承 bot 进程的控制台句柄
 *  - 超时强杀 + 输出截断，防子进程挂起拖垮 bot
 *  - 子进程 PATH 前置 config.reach.binPaths（yt-dlp/mcporter 多为用户级 pip/npm 安装，
 *    看门狗/计划任务启动时用户 PATH 可能与交互终端不同）
 */

import { spawn } from 'node:child_process'
import config from '../config-loader.js'

/** 子进程环境：PATH 前置 binPaths，强制 Python 子进程 UTF-8 输出（Windows 默认 GBK） */
function childEnv() {
  const extra = config.reach?.binPaths || []
  const cur = process.env.PATH || process.env.Path || ''
  const env = { ...process.env, PATH: [...extra, cur].join(';') }
  env.PYTHONIOENCODING = 'utf-8'
  delete env.Path // 统一只留大写 PATH，避免歧义
  return env
}

/**
 * 运行外部命令并收集输出。
 * @param {string} cmd 命令名（靠 PATH 解析，找不到时 code=-1 且 stderr 有原因）
 * @param {string[]} args
 * @param {object} [opts] timeoutMs 默认 30s；maxChars stdout 截断上限默认 400k
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean, spawnError?: string}>}
 */
export function runCli(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000
  const maxChars = opts.maxChars || 400000
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      })
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: '', timedOut: false, spawnError: String(err?.message || err) })
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('kill') } catch { /* 已退出 */ }
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      if (stdout.length < maxChars) stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 20000) stderr += d.toString()
    })
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    }
    child.on('error', (err) => {
      // 命令不存在/无法启动：记录原因后按失败收尾（close 可能不会再触发）
      stderr += `\nspawn失败: ${err.message}`
      finish(-1)
    })
    child.on('close', (code) => finish(code))
  })
}

/** 探测命令是否在 PATH（结果进程内缓存，防反复 spawn where） */
const cliCache = new Map()
export async function hasCli(cmd) {
  if (cliCache.has(cmd)) return cliCache.get(cmd)
  const r = await runCli('where', [cmd], { timeoutMs: 5000, maxChars: 4000 })
  const ok = r.code === 0 && r.stdout.trim().length > 0
  cliCache.set(cmd, ok)
  return ok
}
