import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inlineRefs, resolveOperations } from '../src/spec.ts'
import { buildInput } from '../src/input.ts'
import { Readable } from 'node:stream'
import { buildRequest, rawContentType } from '../src/request.ts'
import type { FileSource } from '../src/multipart.ts'

const petstore = inlineRefs(JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8')))
const ops = resolveOperations(petstore)
const listPets = ops.find(o => o.operationId === 'listPets')!
const getPet = ops.find(o => o.operationId === 'getPet')!
const createPet = ops.find(o => o.operationId === 'createPet')!
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
    op.requestBody = { kind: 'json', schema: { type: 'array', items: { type: 'string' } }, required: true }
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

const filesDoc = inlineRefs(JSON.parse(await readFile(new URL('./fixtures/files.json', import.meta.url), 'utf8')))
const fileOps = resolveOperations(filesDoc)
const memoryFile = (name: string, text: string, contentType?: string): FileSource => {
  const bytes = Buffer.from(text)
  return { name, contentType, size: bytes.length, body: Readable.from([bytes]), close () {} }
}

describe('buildRequest — files', () => {
  it('encodes the bound files and fields as multipart with their exact length', async () => {
    const op = fileOps.find(o => o.operationId === 'createCollection')!
    const { bindings } = buildInput(op, 'en', { files: { maxSize: 1000 } })
    const req = buildRequest(op, bindings, { file: 'https://s3.test/r.csv', title: 'T', draft: false }, base, { file: memoryFile('r.csv', 'a,b', 'text/csv') })
    const bytes = await req.arrayBuffer()
    assert.equal(req.headers.get('content-length'), String(bytes.byteLength))
    const form = await new Response(bytes, { headers: { 'content-type': req.headers.get('content-type')! } }).formData()
    assert.equal(form.get('title'), 'T')
    assert.equal(form.get('draft'), 'false')
    assert.equal((form.get('file') as File).name, 'r.csv')
  })
  it('types a file part by its source, else by the first accepted type', async () => {
    const op = fileOps.find(o => o.operationId === 'createCollection')!
    const { bindings } = buildInput(op, 'en', { files: { maxSize: 1000 } })
    const req = buildRequest(op, bindings, { file: 'https://s3.test/r.csv' }, base, { file: memoryFile('r.csv', 'a,b') })
    const form = await new Response(await req.arrayBuffer(), { headers: { 'content-type': req.headers.get('content-type')! } }).formData()
    assert.equal((form.get('file') as File).type, 'text/csv')
  })
  it('sends a raw file body typed by the source when the operation declares that type', async () => {
    const op = fileOps.find(o => o.operationId === 'bulkLines')!
    const { bindings } = buildInput(op, 'en', { files: { maxSize: 1000 } })
    const req = buildRequest(op, bindings, { id: 'd1', file: 'https://s3.test/l.ndjson' }, base, { file: memoryFile('l.ndjson', '{"a":1}\n', 'application/x-ndjson; charset=utf-8') })
    assert.equal(req.url, 'https://pets.example/api/collections/d1/_bulk_items')
    assert.equal(req.headers.get('content-type'), 'application/x-ndjson')
    assert.equal(req.headers.get('content-length'), '8')
    assert.equal(await req.text(), '{"a":1}\n')
  })
  it('chooses the raw content type among the declared ones', () => {
    assert.equal(rawContentType(['text/csv', 'application/x-ndjson'], 'application/x-ndjson'), 'application/x-ndjson')
    assert.equal(rawContentType(['text/csv', 'application/x-ndjson'], 'binary/octet-stream'), 'text/csv')
    assert.equal(rawContentType(['text/csv'], undefined), 'text/csv')
  })
})
