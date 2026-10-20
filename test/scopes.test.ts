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
    assert.deepEqual(filtered.skills.map(s => s.name), ['editing', 'general'])
  })
  it('a guide whose tools are all filtered out is dropped', async () => {
    const d: any = doc()
    d.tags = [{ name: 'Publishing', 'x-agent': { guide: 'How to publish.' } }, { name: 'Public', 'x-agent': { guide: 'Anyone.' } }]
    d.paths['/items/{id}'].patch.tags = ['Publishing']
    d.paths['/public'].get.tags = ['Public']
    const ts = await load(d, { fetch: fetchFn })
    assert.deepEqual(ts.guides.map(g => [g.name, g.tools]), [['Publishing', ['update_item', 'publish_item']], ['Public', ['public_read']]])
    assert.deepEqual(toolsForScopes(ts, []).guides.map(g => g.name), ['Public'])
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
  it('an entry cannot make a secured operation public', async () => {
    await assert.rejects(load(doc([]), { fetch: fetchFn }), {
      message: 'publish_item: x-agent security [] makes the tool public, the operation\'s security is not'
    })
    await assert.rejects(load(doc([{}]), { fetch: fetchFn }), {
      message: 'publish_item: x-agent security alternative {} is not in the operation\'s security'
    })
  })
  it('a lenient load leaves out an operation whose entry would make it public', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    const ts = await load(doc([]), { fetch: fetchFn, lint: 'warn' })
    assert.deepEqual(names(ts), ['bare_read', 'public_read'])
    assert.deepEqual(names(toolsForScopes(ts, [])), ['public_read'])
    assert.match(String(warn.mock.calls[0].arguments[0]), /publish_item: x-agent security \[\] makes the tool public/)
  })
  it('an entry cannot open an operation that declares no security anywhere', async (t) => {
    const d: any = doc()
    d.paths['/bare'].get['x-agent'] = { name: 'bare_read', security: [] }
    await assert.rejects(load(d, { fetch: fetchFn }), {
      message: 'bare_read: x-agent security [] makes the tool public, the operation\'s security is not'
    })
    const warn = t.mock.method(console, 'warn', () => {})
    const ts = await load(d, { fetch: fetchFn, lint: 'warn' })
    assert.deepEqual(names(ts), ['public_read', 'publish_item', 'update_item'])
    assert.deepEqual(names(toolsForScopes(ts, [])), ['public_read'])
    assert.match(String(warn.mock.calls[0].arguments[0]), /GET \/bare: bare_read: x-agent security \[\] makes the tool public/)
  })
  it('names the view of an array annotation', async () => {
    const d: any = doc()
    d.paths['/items/{id}'].patch['x-agent'][1].security = { oauth2: ['items:admin'] }
    await assert.rejects(load(d, { fetch: fetchFn }), /x-agent invalid at \/paths\/~1items~1\{id\}\/patch\/1: \/security must be array/)
  })
  it('an entry may say public when the operation is', async () => {
    const d: any = doc()
    d.paths['/public'].get['x-agent'] = { name: 'public_read', security: [] }
    d.paths['/bare'].get.security = [{ oauth2: ['items:read'] }, {}]
    d.paths['/bare'].get['x-agent'] = { name: 'bare_read', security: [{}] }
    const ts = await load(d, { fetch: fetchFn })
    assert.deepEqual(names(toolsForScopes(ts, [])), ['bare_read', 'public_read'])
  })
  it('an entry can only narrow its operation\'s security', async () => {
    await assert.rejects(load(doc([]), { fetch: fetchFn }), /publish_item: x-agent security \[\] makes the tool public/)
    await assert.rejects(load(doc([{ oauth2: ['items:read'] }]), { fetch: fetchFn }), /publish_item: x-agent security alternative \{"oauth2":\["items:read"\]\} is not in the operation's security/)
  })
  it('a malformed operation security is refused at load, never in the filter', async (t) => {
    const d: any = doc()
    d.paths['/bare'].get.security = [{ oauth2: 'items:read' }]
    await assert.rejects(load(d, { fetch: fetchFn }), {
      message: 'bare_read: the security of GET /bare is not a list of requirements (scheme name → scope list)'
    })
    const warn = t.mock.method(console, 'warn', () => {})
    const ts = await load(d, { fetch: fetchFn, lint: 'warn' })
    assert.deepEqual(names(toolsForScopes(ts, ['items:read'])), ['public_read'])
    assert.equal(warn.mock.callCount(), 1)
  })
  it('an unresolved $ref under security is refused, never read as the public {}', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {})
    for (const security of [[{ $ref: '#/nowhere' }], { $ref: 'https://elsewhere.test/security.json' }]) {
      const d: any = doc()
      d.paths['/bare'].get.security = security
      await assert.rejects(load(d, { fetch: fetchFn }), /bare_read: the security of GET \/bare is not a list of requirements/)
    }
    // an entry's own is refused earlier, by the vocabulary
    await assert.rejects(load(doc([{ $ref: '#/nowhere' }]), { fetch: fetchFn }), /x-agent invalid at \/paths\/~1items~1\{id\}\/patch\/1: \/security\/0\/\$ref must be array/)
    // elsewhere, the same ref still reads as {}
    const d: any = doc()
    d.paths['/bare'].get.responses[200].content = { 'application/json': { schema: { $ref: '#/nowhere' } } }
    await load(d, { fetch: fetchFn })
    assert.ok(warn.mock.callCount() > 0)
  })
  it('an oauth2 requirement with no scopes is met by any scoped token', async () => {
    const d: any = doc()
    d.paths['/bare'].get.security = [{ oauth2: [] }]
    const ts = await load(d, { fetch: fetchFn })
    assert.equal(names(toolsForScopes(ts, [])).includes('bare_read'), true)
  })
  it('only the oauth2 scheme grants: another scheme name fails closed', async () => {
    const d: any = doc()
    d.paths['/bare'].get.security = [{ openId: ['items:read'] }, { apiKey: [] }]
    const ts = await load(d, { fetch: fetchFn })
    assert.equal(names(toolsForScopes(ts, ['items:read'])).includes('bare_read'), false)
  })
  it('narrowing compares alternatives regardless of key and scope order', async () => {
    const d: any = doc([{ oauth2: ['b', 'a'] }])
    d.paths['/items/{id}'].patch.security = [{ oauth2: ['a', 'b'] }]
    const ts = await load(d, { fetch: fetchFn })
    assert.deepEqual(names(ts), ['bare_read', 'public_read', 'publish_item', 'update_item'])
  })
})
