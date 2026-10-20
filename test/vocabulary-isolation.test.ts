import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'
import { loadSpec } from '../src/spec.ts'
import { instructions } from '../src/adapters/server.ts'

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

describe('an operation whose tool cannot be built', () => {
  const headerParam = { name: 'X-Token', in: 'header', schema: { type: 'string' } }
  const cases: [string, Record<string, unknown>][] = [
    ['response.file with a header parameter', { get: op('bad', { name: 'bad', response: { file: true } }, { parameters: [headerParam] }) }],
    ['selectParam naming a missing parameter', { get: op('bad', { name: 'bad', response: { selectParam: 'nope' } }) }],
    ['an editor reading an unknown operation', { put: op('bad', { name: 'bad', editor: { readOperation: 'missing' } }, { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } }) }]
  ]
  for (const [label, bad] of cases) {
    it(`warn: ${label} leaves only that tool out; error still throws`, async () => {
      let ts: any
      const w = await warnings(async () => { ts = await load(docWith(bad), { lint: 'warn', fetch: fetchFn }) })
      assert.deepEqual(names(ts), ['good'])
      assert.equal(w.length, 1)
      await assert.rejects(load(docWith(bad), { fetch: fetchFn }))
    })
  }
  it('no operationId: left out under warn', async () => {
    const d = docWith({ get: { 'x-agent': { name: 'bad' }, responses: {} } })
    assert.deepEqual(names(await load(d, { lint: 'off', fetch: fetchFn })), ['good'])
    await assert.rejects(load(d, { fetch: fetchFn }), /has x-agent but no operationId/)
  })
  it('a skill does not list a tool that was left out', async () => {
    const d: any = docWith({ get: op('bad', { name: 'bad', futureKey: true }) }, { skills: [{ name: 'sk', description: 'd', body: 'b', tools: ['good', 'bad'] }] })
    const ts = await load(d, { lint: 'off', fetch: fetchFn })
    assert.deepEqual(ts.skills[0].tools, ['good'])
    assert.ok(!instructions(ts).includes('bad'))
  })
  it('an unannotated operation with a finding strips no same-named tool and is worded apart', async () => {
    const d: any = docWith({ get: { operationId: 'good', parameters: [{ name: 'p', in: 'query', schema: { type: 'string' }, 'x-agent': { futureKey: true } }], responses: {} } }, { skills: [{ name: 'sk', description: 'd', body: 'b', tools: ['good'] }] })
    let ts: any
    const w = await warnings(async () => { ts = await load(d, { lint: 'warn', fetch: fetchFn }) })
    assert.deepEqual(ts.skills[0].tools, ['good'])
    assert.equal(w.length, 1)
    assert.match(w[0], /GET \/bad/)
    assert.doesNotMatch(w[0], /their x-agent is not accepted/)
  })
})

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
      await assert.rejects(load(docWith({}, { namePrefix: 'x_' }), { lint, fetch: fetchFn }), /x-agent invalid at \//)
    }
  })
})
