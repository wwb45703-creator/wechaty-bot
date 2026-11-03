import test from 'node:test'
import assert from 'node:assert/strict'
import { checkRoomTrigger, cleanMention } from '../src/handlers/room.js'

test('checkRoomTrigger accurately detects @ with group nicknames, parentheses, and prefixes', async () => {
  const rc = {
    mode: 'mention',
    atNames: ['鹅王', '鹅（王）', '鹅王（励志成为计算机高手）']
  }

  const mockMsg = {
    talker: () => ({ id: 'other_user', self: () => false }),
    room: () => ({ alias: async () => '鹅（王）' }),
    mentionSelf: async () => false,
    wechaty: {
      currentUser: { id: 'bot1', name: () => '鹅（王）' }
    }
  }

  // Case 1: Exact group nickname @
  const t1 = await checkRoomTrigger(mockMsg, '@鹅王（励志成为计算机高手） 你好', rc)
  assert.equal(t1.triggered, true)
  assert.equal(t1.triggerReason, 'mention')

  // Case 2: Standard nickname @
  const t2 = await checkRoomTrigger(mockMsg, '@鹅（王） 还在吗', rc)
  assert.equal(t2.triggered, true)
  assert.equal(t2.triggerReason, 'mention')

  // Case 3: Clean root name @ without parentheses
  const t3 = await checkRoomTrigger(mockMsg, '@鹅王 帮我查一下', rc)
  assert.equal(t3.triggered, true)
  assert.equal(t3.triggerReason, 'mention')

  // Case 4: Any dynamic group nickname starting with 鹅王 even if not in atNames
  const rcDynamic = { mode: 'mention' }
  const t4 = await checkRoomTrigger(mockMsg, '@鹅王（摸鱼中） 出来聊天', rcDynamic)
  assert.equal(t4.triggered, true)
  assert.equal(t4.triggerReason, 'mention')

  // Case 5: @ another group member should NOT trigger
  const t5 = await checkRoomTrigger(mockMsg, '@张三（也是高手） 你怎么看', rc)
  assert.equal(t5.triggered, false)

  // Case 6: self talker never triggers
  const selfMsg = {
    talker: () => ({ id: 'bot1', self: () => true }),
    wechaty: { currentUser: { id: 'bot1', name: () => '鹅（王）' } }
  }
  const t6 = await checkRoomTrigger(selfMsg, '@鹅王 你好', rc)
  assert.equal(t6.triggered, false)
})

test('cleanMention cleanly removes group nickname @ mentions', () => {
  const text1 = '@鹅王（励志成为计算机高手）\u2005今天天气怎么样'
  assert.equal(cleanMention(text1, '鹅（王）'), '今天天气怎么样')

  const text2 = '@鹅（王） 推荐一部电影'
  assert.equal(cleanMention(text2, '鹅（王）'), '推荐一部电影')

  const text3 = '@鹅王 请问你是谁'
  assert.equal(cleanMention(text3, '鹅（王）'), '请问你是谁')
})
