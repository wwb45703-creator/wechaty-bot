import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanBubbleText, formatBotReply, sendBubbles, splitBubbles, stripAtMentions, stripEmojis } from '../src/utils.js'

test('stripEmojis strips all unicode emojis and emoji modifiers cleanly', () => {
  const samples = [
    ['你好😄世界👍', '你好世界'],
    ['测试👍🏻肤色修饰符', '测试肤色修饰符'],
    ['国旗🇨🇳与红心❤️', '国旗与红心'],
    ['多符号组合🤡☕🥱😏😡😒🎉', '多符号组合'],
    ['纯文字 123 English，保留正常标点！。，、', '纯文字 123 English，保留正常标点！。，、'],
  ]
  for (const [input, expected] of samples) {
    assert.equal(stripEmojis(input), expected)
  }
})

test('formatBotReply eliminates all emojis', () => {
  const text = '好的收到😄，马上为您安排👍！'
  assert.equal(formatBotReply(text).includes('😄'), false)
  assert.equal(formatBotReply(text).includes('👍'), false)
})

test('formatBotReply strips trailing rhetorical questions and interrogation clauses', () => {
  assert.equal(formatBotReply('今天天气真好呀！你觉得呢？'), '今天天气真好呀')
  assert.equal(formatBotReply('已经帮你记录好了。有什么可以帮你的吗？'), '已经帮你记录好了')
  assert.equal(formatBotReply('这个操作很简单，直接点确定就行。你懂了吗？'), '这个操作很简单，直接点确定就行')
  assert.equal(formatBotReply('确实是这样。难道不是吗？'), '确实是这样')
  assert.equal(formatBotReply('处理完毕。还有其他问题吗？'), '处理完毕')
})

test('formatBotReply strips trailing interrogative sentences appended after periods', () => {
  const res = formatBotReply('北京今天晴天，最高气温22度。请问你需要更多信息吗？')
  assert.equal(res, '北京今天晴天，最高气温22度')
  assert.equal(res.includes('？'), false)
  assert.equal(res.includes('?'), false)
})

test('formatBotReply eliminates all question marks (? and ？)', () => {
  const inputs = [
    '明天会下雨吗？建议带伞。',
    '网络稍有延迟，稍后重试？',
    '这是第一点？这是第二点？',
  ]
  for (const input of inputs) {
    const output = formatBotReply(input)
    assert.equal(output.includes('？'), false, `Should not contain Chinese question mark: ${output}`)
    assert.equal(output.includes('?'), false, `Should not contain English question mark: ${output}`)
  }
})

test('formatBotReply handles multi-bubble delimiters and edge cases safely', () => {
  assert.equal(formatBotReply(''), '')
  assert.equal(formatBotReply(null), '')
  assert.equal(formatBotReply(undefined), '')
  const multi = formatBotReply('好的收到😄 ||| 正在处理中？')
  assert.equal(multi.includes('😄'), false)
  assert.equal(multi.includes('？'), false)
})

test('reply cleaning preserves source URL queries, fragments, encoding and balanced brackets', () => {
  const urls = [
    'https://example.com/search?q=A&lang=zh#section',
    'https://example.com/a(b)?list[0]=%E4%B8%AD&next=%2Fdocs#part[2',
    'https://example.com/article?title=%E5%A4%A9%E6%B0%94&literal=%7C%7C%7C',
    'http://[2001:db8::1]/docs?q=A#part',
  ]
  for (const url of urls) {
    const output = cleanBubbleText(formatBotReply(`来源：${url}`))
    assert.equal(output, `来源：${url}`)
    assert.deepEqual(splitBubbles(output), [output])
  }
  assert.equal(cleanBubbleText('(https://example.com/a(b)?q=A)'), 'https://example.com/a(b)?q=A')
  assert.equal(formatBotReply('资料：https://example.com?q=A。你觉得呢？'), '资料：https://example.com?q=A')
})

test('URLs survive mention removal and the actual bubble sender with distinct sources retained', async () => {
  const first = 'https://example.com/@小王/search?q=A&lang=zh#section'
  const second = 'https://example.com/@小王/search?q=B&lang=zh#section'
  const reply = formatBotReply(`@小王 资料：${first} ||| 资料：${second}`)
  const bubbles = splitBubbles(stripAtMentions(reply, ['小王']))
  assert.deepEqual(bubbles, [`资料：${first}`, `资料：${second}`])
  const sent = []
  await sendBubbles(async text => { sent.push(text) }, bubbles)
  assert.deepEqual(sent, bubbles)
  assert.deepEqual(splitBubbles(`资料：${first} ||| 资料：${first}`), [`资料：${first}`])
})

test('URL placeholders cannot collide with literal reply text', () => {
  const literal = '\uE000URL0\uE001'
  assert.equal(formatBotReply(`${literal} https://example.com?q=A`), `${literal} https://example.com?q=A`)
})
