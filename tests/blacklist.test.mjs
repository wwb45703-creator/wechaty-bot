import test from 'node:test'
import assert from 'node:assert/strict'
import { isUserBlacklisted, admitMessage } from '../src/messaging.js'

test('isUserBlacklisted matches by name, id, alias, and roomAlias', () => {
  assert.equal(isUserBlacklisted('梁丽', { name: '梁丽', id: 'u1' }), true)
  assert.equal(isUserBlacklisted('梁丽', { name: '其他', id: 'u1', alias: '梁丽' }), true)
  assert.equal(isUserBlacklisted('AAA王倩', { name: 'AAA王倩', id: 'u2' }), true)
  assert.equal(isUserBlacklisted('wenxinyuanwu', { name: '张三', id: 'wenxinyuanwu' }), true)
  assert.equal(isUserBlacklisted('梁丽', { name: '李四', id: 'u3', roomAlias: '梁丽' }), true)
  assert.equal(isUserBlacklisted('梁丽', { name: '王五', id: 'u4' }), false)
  assert.equal(isUserBlacklisted({ id: 'u1' }, { id: 'u1' }), true)
  assert.equal(isUserBlacklisted({ name: '梁丽' }, { name: '梁丽' }), true)
})

test('admitMessage denies blacklisted users across private and room messages', async () => {
  const conf = {
    enabled: true,
    blacklist: ['梁丽', 'AAA王倩', 'wenxinyuanwu'],
    private: { enabled: true },
    rooms: [{ id: 'r1', topic: '测试群', enabled: true, mode: 'all' }]
  }

  const mockTalker1 = { id: 'u1', name: () => '梁丽', alias: async () => '', self: () => false }
  const mockMsg1 = { talker: () => mockTalker1, self: () => false, wechaty: { currentUser: { id: 'bot1' } } }
  assert.equal(await admitMessage(mockMsg1, null, conf), null)

  const mockRoom = { id: 'r1', topic: async () => '测试群', alias: async () => '' }
  assert.equal(await admitMessage(mockMsg1, mockRoom, conf), null)

  const mockTalker2 = { id: 'u2', name: () => 'AAA王倩', alias: async () => '', self: () => false }
  const mockMsg2 = { talker: () => mockTalker2, self: () => false, wechaty: { currentUser: { id: 'bot1' } } }
  assert.equal(await admitMessage(mockMsg2, null, conf), null)
  assert.equal(await admitMessage(mockMsg2, mockRoom, conf), null)

  const mockTalker3 = { id: 'wenxinyuanwu', name: () => '用户3', alias: async () => '', self: () => false }
  const mockMsg3 = { talker: () => mockTalker3, self: () => false, wechaty: { currentUser: { id: 'bot1' } } }
  assert.equal(await admitMessage(mockMsg3, null, conf), null)
  assert.equal(await admitMessage(mockMsg3, mockRoom, conf), null)

  // Non-blacklisted user should be admitted
  const mockTalkerOk = { id: 'ok_user', name: () => '正常用户', alias: async () => '', self: () => false }
  const mockMsgOk = { talker: () => mockTalkerOk, self: () => false, wechaty: { currentUser: { id: 'bot1' } } }
  const admitted = await admitMessage(mockMsgOk, null, conf)
  assert.notEqual(admitted, null)
  assert.equal(admitted.name, '正常用户')
})
