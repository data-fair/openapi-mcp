import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from '../src/load.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))

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
  it('builds the tool set for the default profile with instructions', async () => {
    const ts = await load(petstore, { fetch: stub(() => json({})).fetchFn })
    assert.deepEqual(ts.profiles, ['explore'])
    assert.deepEqual(ts.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.equal(ts.instructions, '## workflow\n\nStart with list_pets, then get_pet.\n\n## Pets\n\nPets have an id and a name.')
    const list = ts.tools[0]
    assert.equal(list.description, 'List pets. Use q for text search.')
    assert.deepEqual(list.annotations, { readOnlyHint: true, destructiveHint: false })
    assert.deepEqual(list.examples, [{ query: 'rex', size: 5 }])
    assert.equal(list.outputSchema, undefined)
  })
  it('localizes and switches profile', async () => {
    const ts = await load(petstore, { profile: 'edit', locale: 'fr', fetch: stub(() => json({})).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['pets_create_pet'])
    assert.equal(ts.instructions, '## workflow\n\nCommencez par list_pets.\n\n## editing\n\nUse create_pet only when asked.\n\n## Pets\n\nPets have an id and a name.')
    assert.equal(ts.tools[0].annotations.readOnlyHint, false)
  })
  it('loads a set of profiles and records it', async () => {
    const ts = await load(petstore, { profiles: ['explore', 'edit'], fetch: stub(() => json({})).fetchFn })
    assert.deepEqual(ts.profiles, ['explore', 'edit'])
    assert.deepEqual(ts.tools.map(t => t.name), ['pets_list_pets', 'pets_create_pet', 'pets_get_pet'])
    assert.match(ts.instructions, /## editing/)
  })
  it('rejects a set naming an undeclared profile', async () => {
    await assert.rejects(load(petstore, { profiles: ['explore', 'nope'] }), /unknown profile "nope" \(declared: explore, edit\)/)
  })
  it('applies a name prefix override', async () => {
    const ts = await load(petstore, { namePrefix: '', fetch: stub(() => json({})).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['list_pets', 'get_pet'])
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
    assert.deepEqual(await ts.tools[1].execute({ id: 'p1' }), { text: '# Rex\n' })
  })
  it('adds structuredContent and outputSchema when asked', async () => {
    const ts = await load(petstore, { fetch: stub(() => json({ id: 'p1', name: 'Rex' })).fetchFn, structuredContent: true })
    assert.equal(ts.tools[1].outputSchema?.type, 'object')
    const res = await ts.tools[1].execute({ id: 'p1' })
    assert.deepEqual(res.structuredContent, { id: 'p1', name: 'Rex' })
  })
  it('uses baseUrl override and empty responses', async () => {
    const { fetchFn, calls } = stub(() => new Response(null, { status: 204 }))
    const ts = await load(petstore, { fetch: fetchFn, baseUrl: 'http://localhost:1234/v1' })
    assert.deepEqual(await ts.tools[1].execute({ id: 'p1' }), { text: 'OK' })
    assert.equal(calls[0].url, 'http://localhost:1234/v1/pets/p1')
  })
  it('fails loudly on an unknown profile', async () => {
    await assert.rejects(load(petstore, { profile: 'nope' }), /unknown profile "nope"/)
  })
  it('treats a 200 with an empty body and json content-type as OK', async () => {
    const ts = await load(petstore, { fetch: stub(() => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })).fetchFn })
    assert.deepEqual(await ts.tools[1].execute({ id: 'p1' }), { text: 'OK' })
  })
  it('reports malformed json bodies as an error instead of throwing', async () => {
    const ts = await load(petstore, { fetch: stub(() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })).fetchFn })
    const res = await ts.tools[1].execute({ id: 'p1' })
    assert.equal(res.isError, true)
    assert.match(res.text, /Invalid JSON response/)
  })
})
