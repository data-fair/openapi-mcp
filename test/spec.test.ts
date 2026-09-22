import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadSpec, inlineRefs, resolveOperations, resolveOperationById, snakeCase, defaultProfile } from '../src/spec.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))

describe('snakeCase', () => {
  it('converts camelCase operation ids', () => {
    assert.equal(snakeCase('getValuesAgg'), 'get_values_agg')
    assert.equal(snakeCase('masterData_singleSearch_{id}'), 'master_data_single_search_id')
  })
})

describe('inlineRefs', () => {
  it('inlines local refs', () => {
    const doc = inlineRefs(structuredClone(petstore))
    assert.equal(doc.paths['/pets'].get.responses[200].content['application/json'].schema.properties.results.items.properties.name.type, 'string')
  })
  it('replaces cycles with an empty schema', () => {
    const doc = inlineRefs({ components: { schemas: { node: { type: 'object', properties: { child: { $ref: '#/components/schemas/node' } } } } } })
    assert.deepEqual(doc.components.schemas.node.properties.child, {})
  })
  it('throws on external refs', () => {
    assert.throws(() => inlineRefs({ a: { $ref: 'other.json#/x' } }), /external \$ref/)
  })
})

describe('loadSpec', () => {
  it('fetches a URL, validates and inlines', async () => {
    const fetchFn = (async () => new Response(JSON.stringify(petstore), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const doc = await loadSpec('https://pets.example/openapi.json', fetchFn)
    assert.equal(doc.info.title, 'Pets')
    assert.equal(doc.paths['/pets'].post.requestBody.content['application/json'].schema.type, 'object')
  })
  it('rejects an invalid x-agent', async () => {
    const bad = structuredClone(petstore)
    bad['x-agent'].bogus = 1
    await assert.rejects(loadSpec(bad, fetch), /x-agent invalid at \//)
  })
})

describe('resolveOperations', () => {
  const doc = inlineRefs(structuredClone(petstore))
  it('defaults to the first declared profile', () => {
    assert.equal(defaultProfile(doc), 'explore')
    assert.equal(defaultProfile({}), 'default')
  })
  it('selects opted-in operations for a profile, with tag inheritance', () => {
    const names = resolveOperations(doc, 'explore').map(o => o.toolName)
    assert.deepEqual(names, ['pets_list_pets', 'pets_get_pet'])
    assert.deepEqual(resolveOperations(doc, 'edit').map(o => o.toolName), ['pets_create_pet'])
  })
  it('selects a set of profiles, each operation once, honouring includes', () => {
    const d = inlineRefs({
      ...petstore,
      'x-agent': { ...petstore['x-agent'], profiles: { explore: {}, edit: { includes: ['explore'] } } }
    })
    const both = resolveOperations(d, ['explore', 'edit']).map(o => o.toolName)
    assert.deepEqual(both, ['pets_list_pets', 'pets_create_pet', 'pets_get_pet'])
    const viaInclude = resolveOperations(d, ['edit']).map(o => o.toolName)
    assert.deepEqual(viaInclude, ['pets_list_pets', 'pets_create_pet', 'pets_get_pet'])
  })
  it('lets the caller override the name prefix — a legacy route serving unprefixed names', () => {
    assert.deepEqual(resolveOperations(doc, 'explore', { namePrefix: '' }).map(o => o.toolName), ['list_pets', 'get_pet'])
    assert.deepEqual(resolveOperations(doc, 'explore', { namePrefix: 'legacy_' }).map(o => o.toolName), ['legacy_list_pets', 'legacy_get_pet'])
  })
  it('never includes an operation without x-agent, even with profile true', () => {
    assert.ok(!resolveOperations(doc, 'explore').some(o => o.operationId === 'deletePet'))
  })
  it('merges path-level and operation-level parameters and x-agent overrides', () => {
    const op = resolveOperations(doc, 'explore').find(o => o.operationId === 'listPets')!
    const size = op.params.find(p => p.name === 'size')!
    assert.deepEqual(size.agent, { maximum: 100, default: 10 })
    const q = op.params.find(p => p.name === 'q')!
    assert.equal(q.agent.name, 'query')
    const get = resolveOperations(doc, 'explore').find(o => o.operationId === 'getPet')!
    assert.equal(get.params[0].in, 'path')
    assert.equal(get.params[0].agent.name, 'id')
  })
  it('captures response schema and media types', () => {
    const get = resolveOperations(doc, 'explore').find(o => o.operationId === 'getPet')!
    assert.deepEqual(get.responseMediaTypes, ['text/markdown', 'application/json'])
    assert.equal(get.responseSchema?.type, 'object')
    const create = resolveOperations(doc, 'edit')[0]
    assert.equal(create.requestBody?.required, true)
  })
  it('throws when two operations resolve to the same tool name', () => {
    const dupeDoc = structuredClone(petstore)
    dupeDoc.paths['/pets/{petId}/twin'] = {
      get: { operationId: 'getPetTwin', 'x-agent': { name: 'list_pets' }, responses: {} }
    }
    assert.throws(() => resolveOperations(inlineRefs(dupeDoc), 'explore'), /duplicate tool names: pets_list_pets/)
  })
})

describe('resolveOperationById', () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/datasets/{id}/schema': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'readSchema',
          parameters: [{ name: 'mimeType', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } }
        }
      }
    }
  }

  it('resolves an operation that has no x-agent at all', () => {
    const op = resolveOperationById(doc, 'readSchema')
    assert.equal(op?.operationId, 'readSchema')
    assert.equal(op?.method, 'GET')
    assert.equal(op?.path, '/datasets/{id}/schema')
    assert.deepEqual(op?.params.map(p => `${p.in}:${p.name}`), ['path:id', 'query:mimeType'])
  })

  it('returns undefined for an unknown id', () => {
    assert.equal(resolveOperationById(doc, 'nope'), undefined)
  })
})
