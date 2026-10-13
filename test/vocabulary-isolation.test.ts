import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'
import { loadSpec } from '../src/spec.ts'
import { createComposer } from '../src/compose.ts'

const op = (id: string, agent: unknown, extra: Record<string, unknown> = {}) => ({
  operationId: id,
  'x-agent': agent,
  responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } },
  ...extra
})

/** a good GET, plus the operation under test */
const docWith = (bad: Record<string, unknown>, root: Record<string, unknown> = {}) => ({
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  servers: [{ url: 'https://api.test' }],
  'x-agent': root,
  paths: {
    '/good': { get: op('good', { name: 'good' }) },
    '/bad': bad
  }
})
const unknownKey = () => docWith({ get: op('bad', { name: 'bad', futureKey: true }) })
const fileOnPost = () => docWith({ post: op('bad', { name: 'bad', response: { file: true } }) })
const names = (ts: { tools: { name: string }[] }) => ts.tools.map(t => t.name)
const fetchFn = (async () => new Response('{}')) as typeof fetch

/** Capture console.warn for the duration of fn. */
async function warnings (fn: () => Promise<unknown>): Promise<string[]> {
  const spy = mock.method(console, 'warn', () => {})
  try {
    await fn()
    return spy.mock.calls.map(c => String(c.arguments[0]))
  } finally {
    spy.mock.restore()
  }
}

describe('an operation annotation this version rejects', () => {
  it('warn: leaves only that operation out and says which and why, once', async () => {
    let ts: any
    const w = await warnings(async () => { ts = await load(unknownKey(), { lint: 'warn', fetch: fetchFn }) })
    assert.deepEqual(names(ts), ['good'])
    assert.equal(w.length, 1)
    assert.match(w[0], /GET \/bad/)
    assert.match(w[0], /futureKey/)
  })
  it('warn: a failed cross-field rule leaves that operation out too', async () => {
    let ts: any
    const w = await warnings(async () => { ts = await load(fileOnPost(), { lint: 'warn', fetch: fetchFn }) })
    assert.deepEqual(names(ts), ['good'])
    assert.match(w[0], /POST \/bad.*response\.file needs a GET/)
  })
  it('warn: a failed body check leaves it out, every view of it', async () => {
    const d = docWith({ post: op('bad', [{ name: 'a' }, { name: 'b', bodyFields: ['nope'] }], { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { x: { type: 'string' } } } } } } }) })
    let ts: any
    const w = await warnings(async () => { ts = await load(d, { lint: 'warn', fetch: fetchFn }) })
    assert.deepEqual(names(ts), ['good'])
    assert.match(w[0], /POST \/bad.*bodyFields names properties the request body does not declare: nope/)
  })
  it('error (the default): throws with the existing message', async () => {
    await assert.rejects(load(unknownKey(), { fetch: fetchFn }), /x-agent invalid at \/paths\/~1bad\/get: .*futureKey/)
    await assert.rejects(load(fileOnPost(), { lint: 'error', fetch: fetchFn }), /x-agent invalid at \/paths\/~1bad\/post: response\.file needs a GET operation/)
    await assert.rejects(loadSpec(unknownKey(), fetchFn), /futureKey/)
  })
  it('off: same as warn, silently', async () => {
    let ts: any
    const w = await warnings(async () => { ts = await load(unknownKey(), { lint: 'off', fetch: fetchFn }) })
    assert.deepEqual(names(ts), ['good'])
    assert.deepEqual(w, [])
  })
  it('a document-level error still fails the document, whatever the level', async () => {
    for (const lint of ['warn', 'off'] as const) {
      await assert.rejects(load(docWith({}, { bogus: 1 }), { lint, fetch: fetchFn }), /x-agent invalid at \//)
      await assert.rejects(load(docWith({}, { profiles: 3 }), { lint, fetch: fetchFn }), /x-agent invalid at \//)
    }
  })
  it('the composer keeps the service ok and serves its other tools', async () => {
    const index = { version: 1 as const, services: [{ id: 'svc', openapi: 'https://svc.test/openapi.json' }] }
    const fetchStub = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      return new Response(JSON.stringify(url.endsWith('openapi.json') ? unknownKey() : {}), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    let c: any
    const w = await warnings(async () => {
      const composer = await createComposer(index, { fetch: fetchStub, lint: 'warn' })
      c = await composer.compose(['default'])
    })
    assert.deepEqual(c.services.map((s: any) => [s.id, s.status, s.tools]), [['svc', 'ok', 1]])
    assert.deepEqual(names(c.toolSet), ['good'])
    assert.equal(w.length, 1)
    const strict = await createComposer(index, { fetch: fetchStub })
    const sc = await strict.compose(['default'])
    assert.equal(sc.services[0].status, 'error')
  })
})
