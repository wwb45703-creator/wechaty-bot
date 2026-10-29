/**
 * verify-skills.mjs — 自进化技能引擎与安全执行门禁专项测试
 *
 * 验收目标：
 *  1. 声明式 DSL 执行器基础功能与插值验证
 *  2. 拒绝未注册动态动作（防恶意命令执行）
 *  3. SSRF 安全防线在 DSL safe_fetch 动作中的 100% 阻断校验
 *  4. L0 技能路由器索引构建与秒级正则匹配
 *  5. tracer 纠错捕获与安全只读落盘
 */

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { renderTemplate, executeSkillPipeline } from '../src/skills/dsl-executor.js'
import { reloadSkills, matchSkill, getSkillSOP } from '../src/skills/skill-router.js'
import { isUserCorrection, recordInteractionTrace } from '../src/skills/tracer.js'

console.log('==================================================')
console.log('  自进化技能引擎与安全执行门禁专项测试')
console.log('==================================================\n')

let pass = 0
let fail = 0

function runTest(title, fn) {
  try {
    fn()
    console.log(`✅ [PASS] ${title}`)
    pass++
  } catch (err) {
    console.error(`❌ [FAIL] ${title}: ${err.message}`)
    fail++
  }
}

async function runAsyncTest(title, fn) {
  try {
    await fn()
    console.log(`✅ [PASS] ${title}`)
    pass++
  } catch (err) {
    console.error(`❌ [FAIL] ${title}: ${err.message}`)
    fail++
  }
}

// 1. 模板变量安全插值
runTest('renderTemplate 安全字符串插值', () => {
  const rendered = renderTemplate('你好 {{name}}，来自 {{place}}', { name: '小明', place: '微信' })
  assert.strictEqual(rendered, '你好 小明，来自 微信')

  // 未提供变量安全置空
  const emptyVal = renderTemplate('数值是：{{missing}}', {})
  assert.strictEqual(emptyVal, '数值是：')
})

// 2. 拒绝未注册动作 (禁止任何动态注入)
await runAsyncTest('DSL 执行器拒绝执行未授权任意动作', async () => {
  const maliciousDsl = {
    executionPlan: {
      pipeline: [
        {
          action: 'shell_exec',
          params: { cmd: 'taskkill /F /IM node.exe' },
        },
      ],
    },
  }

  const res = await executeSkillPipeline(maliciousDsl, { input: 'test' })
  assert.strictEqual(res.ok, false)
  assert.ok(res.error.includes('拒绝执行未注册动作: shell_exec'))
})

// 3. SSRF 防护在 DSL safe_fetch 中的强制生效
await runAsyncTest('DSL safe_fetch 强制拦截私有 IP / 内网穿透', async () => {
  const ssrfDsl = {
    executionPlan: {
      pipeline: [
        {
          action: 'safe_fetch',
          params: { url: 'http://127.0.0.1:11434/api/tags' },
        },
      ],
    },
  }

  const res = await executeSkillPipeline(ssrfDsl)
  assert.strictEqual(res.ok, false)
  assert.ok(res.error.includes('SSRF 防御拦截'))
})

// 4. 正则提取原子动作
await runAsyncTest('DSL regex_extract 正则提取测试', async () => {
  const regexDsl = {
    executionPlan: {
      pipeline: [
        {
          action: 'regex_extract',
          params: {
            pattern: '帮我查一下\\s+([A-Za-z0-9]+)',
            source: '{{input}}',
          },
          exportAs: 'queryRes',
        },
      ],
    },
  }

  const res = await executeSkillPipeline(regexDsl, { input: '帮我查一下 Node18' })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(res.context.$1, 'Node18')
  assert.strictEqual(res.context.queryRes.$1, 'Node18')
})

// 5. L0 技能路由器与匹配测试
runTest('L0 技能路由器索引构建与秒级触发匹配', () => {
  reloadSkills()

  // 命中已沉淀技能
  const matched = matchSkill('请问哪里能看官方文档？')
  assert.ok(matched !== null, '应该命中 jina-doc-reader 技能')
  assert.strictEqual(matched.id, 'jina-doc-reader')

  // 未命中时返回 null
  const unmatch = matchSkill('今天中午吃什么')
  assert.strictEqual(unmatch, null, '无关问题不应命中技能')

  // 获取 SOP
  const sop = getSkillSOP('jina-doc-reader')
  assert.ok(sop.includes('演进技能指导'))
  assert.ok(sop.includes('SOP'))
})

// 6. tracer 纠错判定与提案落盘
runTest('tracer 纠错关键词识别', () => {
  assert.strictEqual(isUserCorrection('不对，你搞错了'), true)
  assert.strictEqual(isUserCorrection('改成明天下午两点'), true)
  assert.strictEqual(isUserCorrection('不要回这么长'), true)
  assert.strictEqual(isUserCorrection('今天天气挺好的'), false)
})

runTest('tracer 安全记录提案文件 (state/proposals/)', () => {
  recordInteractionTrace({
    sessionId: 'test_session_verify',
    userText: '你搞错了，换个方法查文档',
    correction: '换个方法查文档',
    errorMessage: '403 Forbidden',
  })

  const proposalsDir = path.join(process.cwd(), 'state', 'proposals')
  assert.ok(fs.existsSync(proposalsDir), 'proposals 目录应存在')

  const files = fs.readdirSync(proposalsDir).filter((f) => f.startsWith('trace_'))
  assert.ok(files.length > 0, '应成功生成至少一个提案文件')

  // 读取并断言结构安全
  const content = JSON.parse(fs.readFileSync(path.join(proposalsDir, files[0]), 'utf8'))
  assert.strictEqual(content.version, 1)
  assert.strictEqual(content.status, 'pending_reflection')
})

console.log('\n==================================================')
console.log(`自进化技能门禁验收总结: ${pass} 通过 / ${fail} 失败`)
console.log('==================================================')

if (fail > 0) {
  process.exit(1)
} else {
  console.log('🎉 恭喜！技能引擎与安全执行门禁测试全部 100% 通过！')
}
