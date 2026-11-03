import test from 'node:test'
import assert from 'node:assert/strict'
import { createCapabilityMonitor } from '../src/reach/astrbot-health.js'

test('403 capability is latched without polling or repeated logging, while other capabilities work', async () => {
  let now = 0, requests = 0, warnings = 0
  const monitor = createCapabilityMonitor({ now: () => now, notify: () => warnings++ })
  const query = () => { requests++; throw Object.assign(new Error('missing kb'), { code: 'PERMISSION_DENIED', requiredScope: 'kb', httpStatus: 403, retryable: false }) }
  for (let n = 0; n < 20; n++) {
    now += 60000
    const state = await monitor.probe('knowledge', query, { identity: 'key-one' })
    assert.equal(state.status, 'forbidden')
    assert.equal(state.requiredScope, 'kb')
    const plugins = await monitor.probe('plugins', async () => ['working'], { identity: 'key-one' })
    assert.equal(plugins.status, 'ready')
  }
  assert.equal(requests, 1)
  assert.equal(warnings, 1)
  await monitor.probe('knowledge', query, { identity: 'key-one', force: true })
  assert.equal(requests, 2)
  assert.equal(warnings, 1)
  const recovered = await monitor.probe('knowledge', async () => ['authorized'], { identity: 'key-two' })
  assert.equal(recovered.status, 'ready')
})

test('network errors back off and recover, concurrent probes are coalesced', async () => {
  let now = 0, requests = 0
  const monitor = createCapabilityMonitor({ now: () => now })
  await monitor.probe('plugins', async () => { requests++; throw new Error('offline') }, { identity: 'one' })
  await monitor.probe('plugins', async () => { requests++; return [] }, { identity: 'one' })
  assert.equal(requests, 1)
  now = 15001
  let release
  const operation = async () => { requests++; return new Promise(resolve => { release = resolve }) }
  const a = monitor.probe('plugins', operation, { identity: 'one' })
  const b = monitor.probe('plugins', operation, { identity: 'one' })
  release(['ready'])
  assert.equal((await a).status, 'ready')
  assert.equal((await b).status, 'ready')
  assert.equal(requests, 2)
})
