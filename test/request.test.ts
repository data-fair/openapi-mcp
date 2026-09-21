import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inlineRefs, resolveOperations } from '../src/spec.ts'
import { buildInput } from '../src/input.ts'
import { buildRequest } from '../src/request.ts'

const petstore = inlineRefs(JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8')))
const explore = resolveOperations(petstore, 'explore')
const listPets = explore.find(o => o.operationId === 'listPets')!
const getPet = explore.find(o => o.operationId === 'getPet')!
const createPet = resolveOperations(petstore, 'edit')[0]
const base = 'https://pets.example/api/'

describe('buildRequest', () => {
  it('builds query params, spreads objects, applies fixed values and skips response_format', () => {
    const { bindings } = buildInput(listPets, 'en')
    const req = buildRequest(listPets, bindings, { query: 'rex', size: 5, filters: { name_eq: 'Rex', age_gte: '3' }, response_format: 'detailed' }, base)
    const url = new URL(req.url)
    assert.equal(url.origin + url.pathname, 'https://pets.example/api/pets')
    assert.deepEqual([...url.searchParams.entries()], [['q', 'rex'], ['size', '5'], ['name_eq', 'Rex'], ['age_gte', '3'], ['select', 'id,name']])
    assert.equal(req.method, 'GET')
    assert.equal(req.headers.get('accept'), 'application/json')
  })
  it('maps fields onto the select param, overriding the fixed value, joined when explode is false', () => {
    const { bindings } = buildInput(listPets, 'en')
    const req = buildRequest(listPets, bindings, { fields: ['name', 'tags'] }, base)
    assert.deepEqual([...new URL(req.url).searchParams.entries()], [['select', 'name,tags']])
  })
  it('keeps empty strings, drops undefined, repeats exploded arrays', () => {
    const op = structuredClone(listPets)
    op.params.push({ name: 'tag', in: 'query', required: false, schema: { type: 'array', items: { type: 'string' } }, explode: true, agent: {} })
    const { bindings } = buildInput(op, 'en')
    const req = buildRequest(op, bindings, { query: '', size: undefined, tag: ['a', 'b'] }, base)
    assert.deepEqual([...new URL(req.url).searchParams.entries()], [['q', ''], ['tag', 'a'], ['tag', 'b'], ['select', 'id,name']])
  })
  it('encodes path params and prefers text/markdown when declared', () => {
    const { bindings } = buildInput(getPet, 'en')
    const req = buildRequest(getPet, bindings, { id: 'a/b c' }, 'https://pets.example/api')
    assert.equal(req.url, 'https://pets.example/api/pets/a%2Fb%20c')
    assert.equal(req.headers.get('accept'), 'text/markdown')
  })
  it('assembles body properties into a JSON body', async () => {
    const { bindings } = buildInput(createPet, 'en')
    const req = buildRequest(createPet, bindings, { name: 'Rex', tags: ['dog'] }, base)
    assert.equal(req.method, 'POST')
    assert.equal(req.headers.get('content-type'), 'application/json')
    assert.deepEqual(await req.json(), { name: 'Rex', tags: ['dog'] })
  })
  it('sends a whole body and header params', async () => {
    const op = structuredClone(createPet)
    op.requestBody = { schema: { type: 'array', items: { type: 'string' } }, required: true }
    op.params.push({ name: 'x-trace', in: 'header', required: false, schema: { type: 'string' }, agent: {} })
    const { bindings } = buildInput(op, 'en')
    const req = buildRequest(op, bindings, { body: ['a'], 'x-trace': 't1' }, base)
    assert.deepEqual(await req.json(), ['a'])
    assert.equal(req.headers.get('x-trace'), 't1')
  })
  it('throws on a missing required path param', () => {
    const { bindings } = buildInput(getPet, 'en')
    assert.throws(() => buildRequest(getPet, bindings, {}, base), /missing path parameter "id"/)
  })
})
