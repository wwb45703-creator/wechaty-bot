/** Local document workflows exercise persisted state, never a real account. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechaty-knowledge-fixture-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_TEST_MODE = '1'
const store = await import('../src/knowledge/store.js')
const filename = path.join(root, 'state', 'knowledge', 'store.json')
test.after(() => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.match(path.basename(root), /^wechaty-knowledge-fixture-/)
  fs.rmSync(root, { recursive: true, force: true })
})
test.beforeEach(() => {
  if (fs.existsSync(filename)) fs.unlinkSync(filename)
})

test('local knowledge creation, import, retrieval and deletion persist across a new process', () => {
  const kb = store.createKnowledgeBase({ name: '车间手册', description: 'fixture document' })
  const doc = store.importKnowledgeDocument({ kbId: kb.id, name: '温控手册.md', text: '热封设备使用说明：热封温度应设为 85 度，保持压力 3 秒。\n设备故障时先断电。' })
  assert.equal(store.listKnowledgeBases()[0].documents_count, 1)
  const hits = store.queryKnowledgeBase({ kbId: kb.id, query: '热封温度', topK: 3 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].documentName, '温控手册.md')
  assert.equal(hits[0].kbName, '车间手册')
  assert.match(hits[0].content, /85 度/)
  const persisted = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const store = await import(${JSON.stringify(new URL('../src/knowledge/store.js', import.meta.url).href)});
    console.log(JSON.stringify({ bases: store.listKnowledgeBases(), hits: store.queryKnowledgeBase({ query: '热封温度' }) }));
  `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, BOT_DATA_ROOT: root }, timeout: 10000 })
  assert.equal(persisted.status, 0, persisted.stderr)
  const restored = JSON.parse(persisted.stdout.trim())
  assert.equal(restored.bases[0].id, kb.id)
  assert.equal(restored.hits[0].documentId, doc.id)
  assert.throws(() => store.deleteKnowledgeDocument({ kbId: kb.id, documentId: doc.id, confirmed: false }), /确认/)
  assert.equal(store.listKnowledgeDocuments({ kbId: kb.id }).length, 1)
  store.deleteKnowledgeDocument({ kbId: kb.id, documentId: doc.id, confirmed: true })
  assert.deepEqual(store.queryKnowledgeBase({ kbId: kb.id, query: '热封温度' }), [])
  assert.throws(() => store.deleteKnowledgeBase({ id: kb.id, confirmed: false }), /确认/)
  store.deleteKnowledgeBase({ id: kb.id, confirmed: true })
  assert.deepEqual(store.listKnowledgeBases(), [])
})

test('retrieval separates selected libraries, returns no fabricated hit and obeys command activation', () => {
  const a = store.createKnowledgeBase({ name: 'Alpha' })
  const b = store.createKnowledgeBase({ name: 'Beta' })
  store.importKnowledgeDocument({ kbId: a.id, name: 'alpha.txt', text: 'Alpha motor voltage 24V. Red cable carries power.' })
  store.importKnowledgeDocument({ kbId: b.id, name: 'beta.txt', text: 'Beta motor voltage 48V. Blue cable carries power.' })
  const all = store.queryKnowledgeBase({ query: 'motor voltage', topK: 1 })
  assert.equal(all.length, 1)
  assert.equal(store.queryKnowledgeBase({ kbId: b.id, query: 'voltage' })[0].kbId, b.id)
  assert.deepEqual(store.queryKnowledgeBase({ query: 'unfindablefixtureterm' }), [])
  assert.equal(store.answerKnowledgeCommand('普通闲聊'), null)
  assert.match(store.answerKnowledgeCommand('/知识库'), /用法/)
  assert.match(store.answerKnowledgeCommand('/知识库 Beta:voltage'), /48V/)
  assert.doesNotMatch(store.answerKnowledgeCommand('/知识库 Beta:voltage'), /24V/)
  store.updateKnowledgeBase({ id: b.id, enabled: false })
  assert.doesNotMatch(store.answerKnowledgeCommand('/知识库 voltage'), /48V/)
  assert.match(store.answerKnowledgeCommand('/知识库 voltage'), /24V/)
})

test('creating an inactive library preserves its command visibility choice from the first save', () => {
  assert.throws(() => store.createKnowledgeBase({ name: 'invalid', enabled: 'false' }), /布尔/)
  const kb = store.createKnowledgeBase({ name: '仅供整理', enabled: false })
  assert.equal(kb.enabled, false)
  store.importKnowledgeDocument({ kbId: kb.id, name: 'fixture.txt', text: 'fixtureprivatekeyword 温度 85 度' })
  assert.deepEqual(store.queryKnowledgeBase({ query: 'fixtureprivatekeyword' }), [])
  assert.doesNotMatch(store.answerKnowledgeCommand('/知识库 fixtureprivatekeyword'), /85 度/)
  assert.equal(store.queryKnowledgeBase({ kbId: kb.id, query: 'fixtureprivatekeyword' }).length, 1, 'explicit local diagnostics can still inspect inactive drafts')
})

test('invalid imports and malformed persisted state are rejected without replacing existing evidence', () => {
  const kb = store.createKnowledgeBase({ name: 'fixture' })
  assert.throws(() => store.createKnowledgeBase({ name: 'fixture' }), /已存在/)
  assert.throws(() => store.createKnowledgeBase({ name: '  ' }), /不能为空/)
  assert.throws(() => store.importKnowledgeDocument({ kbId: kb.id, name: 'empty.txt', text: '' }), /不能为空/)
  assert.throws(() => store.queryKnowledgeBase({ query: '   ' }), /不能为空/)
  assert.throws(() => store.updateKnowledgeBase({ id: kb.id, enabled: 'false' }), /布尔/)
  assert.throws(() => store.importKnowledgeDocument({ kbId: 'missing', name: 'fixture.txt', text: 'fixture' }), /不存在/)
  const corrupt = '{ fixture corrupt data'
  fs.writeFileSync(filename, corrupt)
  assert.throws(() => store.listKnowledgeBases())
  assert.throws(() => store.createKnowledgeBase({ name: 'must not overwrite' }))
  assert.equal(fs.readFileSync(filename, 'utf8'), corrupt)
})
