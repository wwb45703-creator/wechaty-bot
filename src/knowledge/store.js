import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataPath } from '../runtime-paths.js'

const file = () => dataPath('state', 'knowledge', 'store.json')
function mutate(operation) {
  const lock = dataPath('state', 'knowledge', 'writer.lock')
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  let handle
  try { handle = fs.openSync(lock, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    const pid = Number(fs.readFileSync(lock, 'utf8'))
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('知识库正在写入，请稍后重试')
    try { process.kill(pid, 0); throw new Error('知识库正在写入，请稍后重试') }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe }
    fs.unlinkSync(lock); return mutate(operation)
  }
  try { fs.writeFileSync(handle, String(process.pid)); return operation() }
  finally { fs.closeSync(handle); fs.unlinkSync(lock) }
}
function read() {
  try {
    const value = JSON.parse(fs.readFileSync(file(), 'utf8'))
    if (value.version !== 1 || !Array.isArray(value.bases)) throw new Error('知识库文件格式不正确')
    return value
  } catch (error) { if (error.code === 'ENOENT') return { version: 1, bases: [] }; throw error }
}
function save(value) {
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  const temp = `${file()}.${process.pid}.${randomUUID()}.tmp`
  try { fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file()) }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  if (value.length > max) throw new Error(`${label}最多 ${max} 个字符`)
  return value.trim()
}
function base(state, id) {
  const found = state.bases.find(item => item.id === id)
  if (!found) throw new Error('知识库不存在，请刷新列表')
  return found
}
function summary(item) {
  const { documents, ...meta } = item
  return { ...meta, documents_count: documents.length, chunks_count: documents.reduce((n, doc) => n + doc.chunks.length, 0) }
}
export function listKnowledgeBases() { return read().bases.map(summary) }
function createBase(request = {}) {
  const state = read()
  if (state.bases.length >= 100) throw new Error('最多创建 100 个本地知识库')
  const name = text(request.name, '知识库名称', 100)
  if (request.enabled !== undefined && typeof request.enabled !== 'boolean') throw new Error('启用状态必须为布尔值')
  if (state.bases.some(item => item.name === name)) throw new Error('知识库名称已存在')
  const item = { id: randomUUID(), name, description: String(request.description || '').slice(0, 500), enabled: request.enabled ?? true, documents: [], createdAt: Date.now(), updatedAt: Date.now() }
  state.bases.push(item); save(state); return summary(item)
}
function updateBase(request = {}) {
  const state = read(), item = base(state, request.id)
  if (request.name !== undefined) {
    const name = text(request.name, '知识库名称', 100)
    if (state.bases.some(other => other.id !== item.id && other.name === name)) throw new Error('知识库名称已存在')
    item.name = name
  }
  if (request.description !== undefined) item.description = String(request.description).slice(0, 500)
  if (request.enabled !== undefined) {
    if (typeof request.enabled !== 'boolean') throw new Error('启用状态必须为布尔值')
    item.enabled = request.enabled
  }
  item.updatedAt = Date.now(); save(state); return summary(item)
}
function deleteBase(request = {}) {
  if (request.confirmed !== true) throw new Error('请先确认删除知识库及其文档')
  const state = read(); base(state, request.id)
  state.bases = state.bases.filter(item => item.id !== request.id); save(state)
}
function docSummary(doc) { return { id: doc.id, name: doc.name, chunks_count: doc.chunks.length, createdAt: doc.createdAt, size: doc.size } }
export function listKnowledgeDocuments(request = {}) { return base(read(), request.kbId).documents.map(docSummary) }
function importDocument(request = {}) {
  const state = read(), item = base(state, request.kbId)
  const name = text(request.name, '文档名称', 150), content = text(request.text, '文档内容', 2 * 1024 * 1024)
  if (item.documents.length >= 200) throw new Error('每个知识库最多 200 份文档')
  const total = state.bases.reduce((n, kb) => n + kb.documents.reduce((sum, doc) => sum + doc.size, 0), 0)
  if (total + Buffer.byteLength(content) > 30 * 1024 * 1024) throw new Error('本地知识库容量已达到 30 MB 上限')
  const chunks = []
  for (let start = 0; start < content.length; start += 650) chunks.push(content.slice(start, start + 800))
  const doc = { id: randomUUID(), name, chunks, size: Buffer.byteLength(content), createdAt: Date.now() }
  item.documents.push(doc); item.updatedAt = Date.now(); save(state); return docSummary(doc)
}
function deleteDocument(request = {}) {
  if (request.confirmed !== true) throw new Error('请先确认删除文档')
  const state = read(), item = base(state, request.kbId)
  if (!item.documents.some(doc => doc.id === request.documentId)) throw new Error('文档不存在')
  item.documents = item.documents.filter(doc => doc.id !== request.documentId)
  item.updatedAt = Date.now(); save(state)
}
export const createKnowledgeBase = request => mutate(() => createBase(request))
export const updateKnowledgeBase = request => mutate(() => updateBase(request))
export const deleteKnowledgeBase = request => mutate(() => deleteBase(request))
export const importKnowledgeDocument = request => mutate(() => importDocument(request))
export const deleteKnowledgeDocument = request => mutate(() => deleteDocument(request))
function terms(value) {
  const lower = value.toLowerCase(), words = lower.match(/[a-z0-9_]+/g) || []
  for (const run of lower.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length === 1) words.push(run)
    else for (let i = 0; i < run.length - 1; i++) words.push(run.slice(i, i + 2))
  }
  return [...new Set(words)]
}
export function queryKnowledgeBase(request = {}) {
  const query = text(request.query, '检索问题', 1000), state = read()
  const bases = request.kbId ? [base(state, request.kbId)] : state.bases.filter(item => item.enabled)
  const tokens = terms(query), topK = Math.max(1, Math.min(20, Number.parseInt(request.topK, 10) || 3)), results = []
  if (!tokens.length) throw new Error('请输入中文或英文关键词')
  for (const kb of bases) for (const doc of kb.documents) for (const content of doc.chunks) {
    const lower = content.toLowerCase(), matched = tokens.filter(token => lower.includes(token)).length
    if (!matched) continue
    results.push({ kbId: kb.id, kbName: kb.name, documentId: doc.id, documentName: doc.name, content, score: matched / tokens.length })
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topK)
}
export function answerKnowledgeCommand(question) {
  const match = /^\/?知识库(?:\s+([\s\S]*))?$/.exec(String(question).trim())
  if (!match) return null
  const query = String(match[1] || '').trim()
  if (!query) return '用法：/知识库 问题，或 /知识库 库名:问题。检索控制台中已启用的本地文档。'
  let request = { query, topK: 3 }
  const colon = query.search(/[:：]/)
  if (colon > 0) {
    const name = query.slice(0, colon).trim(), kb = listKnowledgeBases().find(item => item.name === name && item.enabled)
    if (kb) request = { ...request, kbId: kb.id, query: query.slice(colon + 1).trim() }
  }
  try {
    const chunks = queryKnowledgeBase(request)
    return chunks.length ? chunks.map((chunk, index) => `[${index + 1}] ${chunk.kbName} / ${chunk.documentName}\n${chunk.content}`).join('\n\n') : '已启用的本地知识库中没有找到匹配内容。可尝试文档中的关键词。'
  } catch (error) { return `知识库查询失败：${error.message}` }
}
