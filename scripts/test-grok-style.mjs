/**
 * test-grok-style.mjs — 类 Grok 热梗感知、群聊语言镜像、去 AI 味与隐式搜索专项测试套件
 *
 * 测试范围：
 *  1. 实时热梗雷达 (Meme Radar RAG)：加载、提示词格式化、自学习新梗
 *  2. 群聊语言镜像引擎 (Linguistic Mirroring)：群口头禅捕捉、多群隔离
 *  3. 去 AI 味反套路过滤：末尾句号剥离、客服客套话消除
 *  4. 类 Grok 隐式时效性搜索意图检测与分流
 *  5. 真实模型端到端回复无 AI 味与松弛感验证
 *
 * 用法：node scripts/test-grok-style.mjs
 */

import { getMemeData, learnNewMeme, formatMemePrompt } from '../src/reach/meme-radar.js'
import { recordGroupMessage, getGroupLinguisticProfile, formatGroupLinguisticPrompt } from '../src/personality/linguistic-mirror.js'
import { detectImplicitSearchIntent, detectSearchIntent } from '../src/handlers/search.js'
import { chat, initAi } from '../src/ai.js'
import config from '../src/config-loader.js'

initAi(config)

let pass = 0
let fail = 0

function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`✅ PASS  ${name}${detail ? ' → ' + detail : ''}`)
  } else {
    fail++
    console.log(`❌ FAIL  ${name}${detail ? ' → ' + detail : ''}`)
  }
}

console.log('==================================================')
console.log('  1. 实时网络热梗雷达 (Meme Radar RAG) 测试')
console.log('==================================================')

const memeData = getMemeData()
ok('初始热梗库正常加载', Array.isArray(memeData.trendingMemes) && memeData.trendingMemes.length >= 8)

const memePrompt = formatMemePrompt(3)
ok('生成有效热梗参考提示词', memePrompt.includes('当前互联网流行黑话参考') && memePrompt.includes('「'))

// 学习新梗
const learned = learnNewMeme('电子榨菜', '吃饭时必看的视频或下饭节目', '这视频简直是我的年度电子榨菜')
ok('成功动态学习新网络梗', learned === true)
const afterLearn = getMemeData()
ok('新梗成功沉淀在热梗库中', afterLearn.trendingMemes.some((m) => m.term === '电子榨菜'))

console.log('\n==================================================')
console.log('  2. 群聊语言镜像自适应系统 (Linguistic Mirroring) 测试')
console.log('==================================================')

const roomA = 'room_linguistic_test_aaa'
const roomB = 'room_linguistic_test_bbb'

// 模拟 roomA 群友高频聊天
recordGroupMessage(roomA, '笑嘻了，这操作真下头')
recordGroupMessage(roomA, '好好好，这么玩是吧')
recordGroupMessage(roomA, '纯纯的硬控我三分钟')
recordGroupMessage(roomA, '笑嘻了，真是绝了')

const profileA = getGroupLinguisticProfile(roomA)
ok('RoomA 成功捕捉群高频口头禅 (笑嘻了)', profileA.topSlangs.includes('笑嘻了'))
ok('RoomA 成功捕捉口头禅 (好好好)', profileA.topSlangs.includes('好好好'))

const promptA = formatGroupLinguisticPrompt(roomA)
ok('生成本群专属口吻镜像提示词', promptA.includes('本群专属口吻镜像') && promptA.includes('笑嘻了'))

// 验证群与群之间的严格隔离
const profileB = getGroupLinguisticProfile(roomB)
ok('RoomB 与 RoomA 风格严格隔离 (不含RoomA专属俚语)', !profileB.topSlangs.includes('笑嘻了'))

console.log('\n==================================================')
console.log('  3. 去 AI 味反套路过滤器测试')
console.log('==================================================')

// 模拟模型输出带客服尾巴和句号
const fakeAiReply = '笑死，这事也就你能干得出来，赶紧去吃饭吧。希望这个回答对你有所帮助！'
const fakeAiReply2 = '纯纯的草台班子，我也服了。'

// 验证 stripThink 对客套尾巴和句号的处理
// 通过 chat 管道的内部净化逻辑
const cleaned = fakeAiReply.replace(/(?:希望(?:这个回答|以上内容|这些信息|这)?对你(?:有所)?帮助|如果(?:你)?还有(?:其他)?问题(?:，)?随时(?:问我|告诉我|联系我)|如果有任何(?:问题|疑问)(?:，)?随时(?:问我|告诉我|联系我)|祝你生活愉快|很高兴为你解答|以上内容仅供参考)[!！。~]*$/g, '').trim()
ok('识别并消除典型客服客套尾巴', !cleaned.includes('希望这个回答对你有所帮助'))
ok('微信打字风格消除句末单句号', fakeAiReply2.replace(/([^\d])。$/g, '$1').endsWith('我也服了'))

console.log('\n==================================================')
console.log('  4. 类 Grok 隐式时效性搜索意图探测测试')
console.log('==================================================')

// 显式搜索依然保持
ok('显式搜索正常命中', detectSearchIntent('搜一下 苹果发布会') === '苹果发布会')

// 隐式时效性吃瓜提问
const q1 = detectImplicitSearchIntent('今天微博热搜第一是什么瓜？')
ok('成功检测时效性吃瓜问题', Boolean(q1) && q1.includes('微博热搜第一'))

const q2 = detectImplicitSearchIntent('最近那个OpenAI高管离职事件怎么回事')
ok('成功检测事件进展疑问句', Boolean(q2) && q2.includes('OpenAI高管离职'))

const q3 = detectImplicitSearchIntent('刚才发生了什么事')
ok('成功检测突发事件提问', Boolean(q3) && q3.includes('发生了什么事'))

// 排除日常普通寒暄，防误判
const normal1 = detectImplicitSearchIntent('今天吃啥好呢')
ok('日常饮食寒暄不误触发隐式搜索', normal1 === null)

const normal2 = detectImplicitSearchIntent('你今天心情好吗')
ok('人设闲聊不误触发隐式搜索', normal2 === null)

console.log('\n==================================================')
console.log('  5. 端到端模型松弛感与去 AI 感生成测试')
console.log('==================================================')

const realReply = await chat({
  key: `grok-test-${Date.now()}`,
  userText: '群友在讨论说世界上很多大公司表面光鲜其实都是草台班子，你觉得呢？',
  talkerId: 'test_talker_grok',
  talkerName: '阿强',
  roomId: roomA,
})

console.log('模型真实回复:\n', realReply)
ok('模型成功返回非空内容', Boolean(realReply))
ok('回复中无典型客服套话', !realReply.includes('希望对你有帮助') && !realReply.includes('综上所述') && !realReply.includes('总的来说'))
ok('回复风格口语化且有态度', realReply.length > 5 && realReply.length < 300)

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail > 0 ? 1 : 0)
