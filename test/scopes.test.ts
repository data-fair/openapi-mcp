import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'
import { toolsForScopes } from '../src/scopes.ts'

const fetchFn = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof fetch
const idParam = { in: 'path', name: 'id', required: true, schema: { type: 'string' } }
const itemBody = { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, sites: { type: 'array', items: { type: 'string' } } } } } } }

const doc = (publishSecurity: unknown[] = [{ apiKey: [] }, { oauth2: ['items:admin'] }, { oauth2: ['items'] }], skills: unknown[] = []) => ({
  openapi: '3.1.0',
  info: { title: 'Items', version: '1' },
  servers: [{ url: 'https://items.test/api' }],
  'x-agent': { skills },
  paths: {
    '/items/{id}': {
      patch: {
        operationId: 'patchItem',
        parameters: [idParam],
        requestBody: itemBody,
        security: [{ apiKey: [] }, { oauth2: ['items:write'] }, { oauth2: ['items:admin'] }, { oauth2: ['items'] }],
        'x-agent': [
          { name: 'update_item', bodyFields: ['title'] },
          { name: 'publish_item', bodyFields: ['sites'], security: publishSecurity }
        ],
        responses: { 200: { description: 'ok' } }
      }
    },
    '/public': { get: { operationId: 'getPublic', security: [], 'x-agent': { name: 'public_read' }, responses: { 200: { description: 'ok' } } } },
    '/bare': { get: { operationId: 'getBare', 'x-agent': { name: 'bare_read' }, responses: { 200: { description: 'ok' } } } }
  }
})

const names = (ts: { tools: { name: string }[] }) => ts.tools.map(t => t.name).sort()

describe('toolsForScopes', () => {
  it('keeps the tools an alternative of their security grants', async () => {
    const ts = await load(doc(), { fetch: fetchFn })
    assert.deepEqual(names(toolsForScopes(ts, ['items:write'])), ['public_read', 'update_item'])
    assert.deepEqual(names(toolsForScopes(ts, ['items:admin'])), ['public_read', 'publish_item', 'update_item'])
    assert.deepEqual(names(toolsForScopes(ts, ['items'])), ['public_read', 'publish_item', 'update_item'])
    assert.deepEqual(names(toolsForScopes(ts, ['items:read'])), ['public_read'])
  })
  it('an unscoped session keeps every tool, the same tool set', async () => {
    const ts = await load(doc(), { fetch: fetchFn })
    assert.equal(toolsForScopes(ts, undefined), ts)
    assert.deepEqual(names(toolsForScopes(ts, undefined)), ['bare_read', 'public_read', 'publish_item', 'update_item'])
  })
  it('a tool carries its effective security: entry, else operation, else root', async () => {
    const d: any = doc()
    d.security = [{ oauth2: ['root'] }]
    const ts = await load(d, { fetch: fetchFn })
    const security = Object.fromEntries(ts.tools.map(t => [t.name, t.security]))
    assert.deepEqual(security.update_item, d.paths['/items/{id}'].patch.security)
    assert.deepEqual(security.publish_item, [{ apiKey: [] }, { oauth2: ['items:admin'] }, { oauth2: ['items'] }])
    assert.deepEqual(security.public_read, [])
    assert.deepEqual(security.bare_read, [{ oauth2: ['root'] }])
  })
  it('a requirement needing two scopes needs both', async () => {
    const d: any = doc()
    d.paths['/bare'].get.security = [{ oauth2: ['a', 'b'] }]
    const ts = await load(d, { fetch: fetchFn })
    assert.equal(names(toolsForScopes(ts, ['a'])).includes('bare_read'), false)
    assert.equal(names(toolsForScopes(ts, ['a', 'b'])).includes('bare_read'), true)
  })
  it('an empty requirement is public', async () => {
    const d: any = doc()
    d.paths['/bare'].get.security = [{ oauth2: ['items:admin'] }, {}]
    const ts = await load(d, { fetch: fetchFn })
    assert.deepEqual(names(toolsForScopes(ts, [])), ['bare_read', 'public_read'])
  })
  it('a skill whose tools are all filtered out is dropped', async () => {
    const ts = await load(doc(undefined, [
      { name: 'publishing', description: 'How to publish.', tools: ['publish_item'] },
      { name: 'editing', description: 'How to edit.', tools: ['update_item', 'publish_item'] },
      { name: 'general', description: 'About items.' }
    ]), { fetch: fetchFn })
    const filtered = toolsForScopes(ts, ['items:write'])
    assert.deepEqual(filtered.skills.map(s => s.id), ['editing', 'general'])
    assert.doesNotMatch(filtered.instructions, /publishing/)
    assert.match(filtered.instructions, /## editing/)
    assert.equal(filtered.guideInstructions, ts.guideInstructions)
  })
  it('widening entry security is refused', async () => {
    const widening = [{ apiKey: [] }, { oauth2: ['items:read'] }]
    await assert.rejects(load(doc(widening), { fetch: fetchFn }), {
      message: 'publish_item: x-agent security alternative {"oauth2":["items:read"]} is not in the operation\'s security'
    })
  })
  it('a lenient load leaves a widening operation out', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    const ts = await load(doc([{ oauth2: ['items:read'] }]), { fetch: fetchFn, lint: 'warn' })
    assert.deepEqual(names(ts), ['bare_read', 'public_read'])
    assert.match(String(warn.mock.calls[0].arguments[0]), /PATCH \/items\/\{id\}: publish_item: x-agent security alternative/)
  })
  it('narrowing compares alternatives regardless of key and scope order', async () => {
    const d: any = doc([{ oauth2: ['b', 'a'] }])
    d.paths['/items/{id}'].patch.security = [{ oauth2: ['a', 'b'] }]
    const ts = await load(d, { fetch: fetchFn })
    assert.deepEqual(names(ts), ['bare_read', 'public_read', 'publish_item', 'update_item'])
  })
})
