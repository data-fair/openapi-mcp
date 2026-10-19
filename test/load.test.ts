import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from '../src/load.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
const views = JSON.parse(await readFile(new URL('./fixtures/views.json', import.meta.url), 'utf8'))

/** fetch stub recording requests and answering from a handler */
function stub (handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    calls.push(req)
    return handler(req)
  }) as typeof fetch
  return { fetchFn, calls }
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

describe('load', () => {
  it('builds the tool set with instructions', async () => {
    const ts = await load(petstore, { fetch: stub(() => json({})).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['list_pets', 'create_pet', 'get_pet'])
    assert.equal(ts.instructions, '## workflow\n\nStart with list_pets, then get_pet.\n\nRead it as the MCP resource skill://workflow/SKILL.md.\n\n## editing\n\nUse create_pet only when asked.\n\nRead it as the MCP resource skill://editing/SKILL.md.\n\n## Pets\n\nPets have an id and a name.')
    const list = ts.tools[0]
    assert.equal(list.description, 'List pets. Use q for text search.')
    assert.deepEqual(list.annotations, { readOnlyHint: true, destructiveHint: false })
    assert.deepEqual(list.examples, [{ query: 'rex', size: 5 }])
    assert.equal(list.outputSchema, undefined)
    assert.equal(ts.tools[1].annotations.readOnlyHint, false)
    assert.deepEqual(ts.skills.map(s => [s.id, s.description]), [['workflow', 'Start with list_pets, then get_pet.'], ['editing', 'Use create_pet only when asked.']])
  })
  it('localizes', async () => {
    const ts = await load(petstore, { locale: 'fr', fetch: stub(() => json({})).fetchFn })
    assert.equal(ts.tools[0].description, 'Lister les animaux.')
    assert.match(ts.instructions, /^## workflow\n\nCommencez par list_pets\./)
  })
  it('applies the call context to the upstream request', async () => {
    const { fetchFn, calls } = stub(() => json({ total: 0, results: [] }))
    const ts = await load(petstore, { fetch: fetchFn })
    await ts.tools[0].execute({}, { headers: { cookie: 'id_token=abc' } })
    assert.equal(calls[0].headers.get('cookie'), 'id_token=abc')
  })
  it('executes: validates, fetches with defaults applied, renders', async () => {
    const { fetchFn, calls } = stub(() => json({ total: 1, results: [{ id: 'p1', name: 'Rex', internalCode: 'X' }], meta: { hints: ['h'] } }))
    const ts = await load(petstore, { fetch: fetchFn })
    const res = await ts.tools[0].execute({ query: 'rex' })
    assert.equal(calls[0].url, 'https://pets.example/api/pets?q=rex&size=10&select=id%2Cname')
    assert.equal(res.isError, undefined)
    assert.equal(res.text, '- **total**: 1\n\n| id | name |\n| --- | --- |\n| p1 | Rex |\n> id: opaque, never shown to users\n\n> Hint: h')
    assert.equal(res.structuredContent, undefined)
  })
  it('rejects invalid params before fetching', async () => {
    const { fetchFn, calls } = stub(() => json({}))
    const ts = await load(petstore, { fetch: fetchFn })
    const res = await ts.tools[0].execute({ size: 500 })
    assert.equal(res.isError, true)
    assert.match(res.text, /Invalid parameters: \/size must be <= 100/)
    assert.equal(calls.length, 0)
  })
  it('returns HTTP errors verbatim, truncated', async () => {
    const ts = await load(petstore, { fetch: stub(() => new Response('x'.repeat(50), { status: 400 })).fetchFn, maxErrorLength: 10 })
    const res = await ts.tools[0].execute({})
    assert.deepEqual(res, { isError: true, text: 'HTTP 400: xxxxxxxxxx…' })
  })
  it('reports network failures', async () => {
    const ts = await load(petstore, { fetch: stub(() => { throw new Error('boom') }).fetchFn })
    assert.deepEqual(await ts.tools[0].execute({}), { isError: true, text: 'Request failed: boom' })
  })
  it('passes text/markdown responses through', async () => {
    const ts = await load(petstore, { fetch: stub(() => new Response('# Rex\n', { headers: { 'content-type': 'text/markdown' } })).fetchFn })
    assert.deepEqual(await ts.tools[2].execute({ id: 'p1' }), { text: '# Rex\n' })
  })
  it('adds structuredContent and outputSchema when asked', async () => {
    const ts = await load(petstore, { fetch: stub(() => json({ id: 'p1', name: 'Rex' })).fetchFn, structuredContent: true })
    assert.equal(ts.tools[2].outputSchema?.type, 'object')
    const res = await ts.tools[2].execute({ id: 'p1' })
    assert.deepEqual(res.structuredContent, { id: 'p1', name: 'Rex' })
  })
  it('uses baseUrl override and empty responses', async () => {
    const { fetchFn, calls } = stub(() => new Response(null, { status: 204 }))
    const ts = await load(petstore, { fetch: fetchFn, baseUrl: 'http://localhost:1234/v1' })
    assert.deepEqual(await ts.tools[2].execute({ id: 'p1' }), { text: 'OK' })
    assert.equal(calls[0].url, 'http://localhost:1234/v1/pets/p1')
  })
  it('treats a 200 with an empty body and json content-type as OK', async () => {
    const ts = await load(petstore, { fetch: stub(() => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })).fetchFn })
    assert.deepEqual(await ts.tools[2].execute({ id: 'p1' }), { text: 'OK' })
  })
  it('reports malformed json bodies as an error instead of throwing', async () => {
    const ts = await load(petstore, { fetch: stub(() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })).fetchFn })
    const res = await ts.tools[2].execute({ id: 'p1' })
    assert.equal(res.isError, true)
    assert.match(res.text, /Invalid JSON response/)
  })
})

describe('load — one document, no profiles', () => {
  const doc = (rootAgent: Record<string, unknown> = {}, opAgent: Record<string, unknown> = { name: 'list_things' }) => ({
    openapi: '3.1.0',
    info: { title: 'Things', version: '1' },
    servers: [{ url: 'https://things.test/api' }],
    'x-agent': rootAgent,
    paths: {
      '/things': {
        get: { operationId: 'listThings', 'x-agent': opAgent, responses: { 200: { description: 'ok' } } },
        post: { operationId: 'createThing', 'x-agent': {}, responses: { 201: { description: 'created' } } }
      },
      '/things/{id}': {
        delete: { operationId: 'deleteThing', parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'gone' } } }
      }
    }
  })

  it('loads every annotated operation without profiles', async () => {
    const toolSet = await load(doc(), { fetch: stub(() => json({})).fetchFn })
    assert.deepEqual(toolSet.tools.map(t => t.name), ['list_things', 'create_thing'])
    assert.equal('profiles' in toolSet, false)
  })
  it('refuses profiles and namePrefix in x-agent', async () => {
    await assert.rejects(load(doc({ namePrefix: 'x_' })), /namePrefix/)
    await assert.rejects(load(doc({}, { profiles: ['read'] })), /profiles/)
  })
  it('all root skills are listed', async () => {
    const toolSet = await load(doc({ skills: [{ name: 'how-to', description: 'How to handle things.' }] }), { fetch: stub(() => json({})).fetchFn })
    assert.deepEqual(toolSet.skills.map(s => s.id), ['how-to'])
  })
})

describe('load — operation views', () => {
  it('builds one tool per view, each with its own description and annotations', async () => {
    const ts = await load(views, { fetch: stub(() => json({ id: '1' })).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['update_thing', 'publish_thing'])
    assert.equal(ts.tools[1].description, 'Choose the sites a thing is published on.')
    assert.deepEqual(ts.tools[1].annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true })
  })
  it('sends only the allowed fields, and refuses others before any request', async () => {
    const s = stub(() => json({ id: '1' }))
    const ts = await load(views, { fetch: s.fetchFn })
    const publish = ts.tools.find(t => t.name === 'publish_thing')!
    const refused = await publish.execute({ id: '1', publicationSites: ['portal-a'], title: 'x' })
    assert.equal(refused.isError, true)
    assert.match(refused.text, /^Invalid parameters/)
    assert.equal(s.calls.length, 0)
    const ok = await publish.execute({ id: '1', publicationSites: ['portal-a'] })
    assert.ok(!ok.isError, ok.text)
    assert.equal(s.calls[0].method, 'PATCH')
    assert.equal(s.calls[0].url, 'https://things.test/api/things/1')
    assert.deepEqual(await s.calls[0].json(), { publicationSites: ['portal-a'] })
  })
  it('refuses a compact body carrying a field outside the view, before any request', async () => {
    const doc = structuredClone(views)
    doc.paths['/things/{id}'].patch['x-agent'][1].body = 'compact'
    const s = stub(() => json({ id: '1' }))
    const ts = await load(doc, { fetch: s.fetchFn })
    const publish = ts.tools.find(t => t.name === 'publish_thing')!
    const refused = await publish.execute({ id: '1', body: { publicationSites: ['portal-a'], title: 'x' } })
    assert.equal(refused.isError, true)
    assert.match(refused.text, /^Invalid body/)
    assert.equal(s.calls.length, 0)
  })
})

describe('load — linked skills', () => {
  const skilled = (skills: unknown[], servers = [{ url: 'https://api.test/v1' }]) => ({
    ...structuredClone(petstore),
    servers,
    'x-agent': { ...petstore['x-agent'], skills }
  })
  const bodies = (files: Record<string, string>) => stub(req => req.url in files
    ? new Response(files[req.url], { headers: { 'content-type': 'text/markdown' } })
    : new Response('no', { status: 404 }))

  it('resolves a relative link under servers[0].url for a document passed as an object', async () => {
    const s = bodies({ 'https://api.test/v1/agents/skills/w.md': '---\nname: w\n---\nThe body.' })
    const ts = await load(skilled([{ name: 'w', description: 'When w.', href: 'agents/skills/w.md' }]), { fetch: s.fetchFn })
    assert.deepEqual(ts.skills.map(x => [x.id, x.body, x.error]), [['w', 'The body.', undefined]])
  })

  it('resolves against the document URL when loaded from a URL, or the documentUrl option', async () => {
    const doc = skilled([{ name: 'w', description: 'When w.', href: 'skills/w.md' }], [{ url: 'https://elsewhere.test/api' }])
    const s = stub(req => req.url === 'https://docs.test/v2/openapi.json' ? json(doc) : req.url === 'https://docs.test/v2/skills/w.md' ? new Response('From the doc URL.') : new Response('no', { status: 404 }))
    assert.equal((await load('https://docs.test/v2/openapi.json', { fetch: s.fetchFn })).skills[0].body, 'From the doc URL.')
    assert.equal((await load(doc, { fetch: s.fetchFn, documentUrl: 'https://docs.test/v2/openapi.json' })).skills[0].body, 'From the doc URL.')
  })

  it('lists skills in the instructions without bodies, pointing to their resources', async () => {
    const s = bodies({ 'https://api.test/v1/w.md': 'SECRET BODY' })
    const ts = await load(skilled([{ name: 'w', description: 'When w.', href: 'w.md', tools: ['list_pets'] }]), { fetch: s.fetchFn })
    assert.equal(ts.instructions, '## w\n\nWhen w.\n\nTools: list_pets\nRead it as the MCP resource skill://w/SKILL.md.\n\n## Pets\n\nPets have an id and a name.')
    assert.equal(ts.guide, '## Pets\n\nPets have an id and a name.')
    assert.deepEqual(ts.tools.map(t => t.name), ['list_pets', 'create_pet', 'get_pet'])
    assert.equal(ts.skills[0].body, 'SECRET BODY\n\nTools: list_pets')
  })

  it('keeps serving when a body is unreachable', async () => {
    const ts = await load(skilled([{ name: 'w', description: 'When w.', href: 'gone.md' }]), { fetch: bodies({}).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['list_pets', 'create_pet', 'get_pet'])
    assert.match(ts.skills[0].error!, /HTTP 404 \(https:\/\/api\.test\/v1\/gone\.md\)/)
  })
})
