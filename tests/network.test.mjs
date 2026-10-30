import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createExternalClient, isPrivateIp, validateExternalUrl } from '../src/external-http.js'
import { extractFirstUrl, fetchPageText } from '../src/url-utils.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-network-'))
process.env.BOT_DATA_ROOT = root
process.env.BOT_CONFIG_FILE = path.join(root, 'config.json')
fs.writeFileSync(process.env.BOT_CONFIG_FILE, JSON.stringify({ reach: { enabled: true, jina: { enabled: true } } }))
const { createRichFetcher, NETWORK_CAPABILITIES } = await import('../src/reach/index.js')
test.after(() => fs.rmSync(root, { recursive: true, force: true }))
const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const response = (body, status = 200, headers = {}) => ({ status, headers, body: Buffer.from(body) })

test('private, special, mapped IPv6 and numeric URL forms cannot reach a transport', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:7f00:1', '2001:db8::1', '2002:7f00:1::1']) assert.equal(isPrivateIp(ip), true, ip)
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip)
  let called = 0
  const client = createExternalClient({ lookup, request: async () => { called++; return response('bad') } })
  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:7f00:1]/', 'file:///etc/passwd', 'http://localhost/', 'http://host.internal/', 'https://user:secret@example.com/']) {
    await assert.rejects(client(url), error => error.fatal === true)
  }
  assert.equal(called, 0)
})

test('mixed DNS answers and public-to-private redirects are terminal', async () => {
  const mixed = await validateExternalUrl('https://example.com', { lookup: async () => [...await lookup(), { address: '10.0.0.1', family: 4 }] })
  assert.equal(mixed.ok, false)
  const seen = []
  const client = createExternalClient({ lookup, request: async (url, options) => {
    seen.push({ url: url.href, checked: options.addresses[0].address })
    return response('', 302, { location: 'http://127.0.0.1/admin' })
  } })
  await assert.rejects(client('https://example.com'), error => error.fatal)
  assert.deepEqual(seen, [{ url: 'https://example.com/', checked: '93.184.216.34' }])
})

test('every redirect is resolved again and transport receives exactly the validated address', async () => {
  const resolutions = [], pins = []
  const client = createExternalClient({ lookup: async host => {
    resolutions.push(host)
    return [{ address: host === 'example.com' ? '8.8.8.8' : '1.1.1.1', family: 4 }]
  }, request: async (url, options) => {
    pins.push(options.addresses[0].address)
    return url.hostname === 'example.com' ? response('', 302, { location: 'https://second.example/page' }) : response('<title>文档</title><p>有效正文</p>')
  } })
  const page = await fetchPageText('https://example.com', { client })
  assert.equal(page.ok, true); assert.equal(page.title, '文档'); assert.match(page.text, /有效正文/)
  assert.deepEqual(resolutions, ['example.com', 'second.example']); assert.deepEqual(pins, ['8.8.8.8', '1.1.1.1'])
})

test('body-stall and DNS-stall share a hard deadline even if dependency ignores cancellation', async () => {
  const pending = () => new Promise(() => {})
  for (const dependencies of [{ lookup: pending, request: pending }, { lookup, request: pending }]) {
    const start = Date.now()
    await assert.rejects(createExternalClient(dependencies)('https://example.com', { timeoutMs: 30 }), /取消|超时/)
    assert.ok(Date.now() - start < 1000)
  }
})

test('external signal cancels request and response bytes are strictly bounded', async () => {
  const ctrl = new AbortController()
  const pending = createExternalClient({ lookup, request: () => new Promise(() => {}) })('https://example.com', { signal: ctrl.signal })
  ctrl.abort()
  await assert.rejects(pending)
  const client = createExternalClient({ lookup, request: async () => response('x'.repeat(500000)) })
  const res = await client('https://example.com', { maxBytes: 900000 })
  assert.equal((await res.text()).length, 400000)
})

test('SSRF failure never invokes another fallback, including opted-in reader', async () => {
  let calls = 0
  const fetcher = createRichFetcher({ validate: async () => ({ ok: true }),
    platform: async () => null, reader: async () => ({ ok: false, fatal: true, code: 'BLOCKED_URL' }),
    jina: async () => { calls++; return { ok: true } } })
  assert.equal((await fetcher('https://example.com')).fatal, true)
  assert.equal(calls, 0)
  assert.equal(NETWORK_CAPABILITIES.scrapling, false)
  assert.equal(NETWORK_CAPABILITIES.browser, false)
  assert.equal(NETWORK_CAPABILITIES.agentReach, false)
})

test('URL extraction and plain-reader failure contracts are preserved', async () => {
  assert.equal(extractFirstUrl('看看 https://example.com/a。'), 'https://example.com/a')
  assert.equal(extractFirstUrl('无链接'), null)
  const result = await fetchPageText('https://example.com', { client: async () => new Response('', { status: 404 }) })
  assert.equal(result.ok, false)
})
