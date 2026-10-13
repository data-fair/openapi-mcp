import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadSpec, inlineRefs, resolveOperations, resolveOperationById, snakeCase, defaultProfile, resolveBody } from '../src/spec.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
const views = JSON.parse(await readFile(new URL('./fixtures/views.json', import.meta.url), 'utf8'))

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

describe('operation views', () => {
  const doc = inlineRefs(structuredClone(views))
  it('resolves one operation per selected view, in view order', () => {
    assert.deepEqual(resolveOperations(doc, 'write').map(o => o.toolName), ['t_update_thing'])
    const both = resolveOperations(doc, 'manage')
    assert.deepEqual(both.map(o => o.toolName), ['t_update_thing', 't_publish_thing'])
    assert.deepEqual(both.map(o => o.operationId), ['patchThing', 'patchThing'])
    assert.deepEqual(both.map(o => o.agent.bodyFields), [['title', 'description'], ['publicationSites']])
    assert.deepEqual(both[1].agent.annotations, { idempotentHint: true })
  })
  it('resolves the raw operation for an editor reference, ignoring the views', () => {
    const op = resolveOperationById(doc, 'patchThing')!
    assert.equal(op.toolName, 't_patch_thing')
    assert.deepEqual(op.agent, { profiles: true })
  })
})

describe('loadSpec — bodyFields checked on every view', () => {
  it('refuses a misspelled field on a view no profile set has selected yet', async () => {
    const doc = structuredClone(views)
    doc.paths['/things/{id}'].patch['x-agent'][1].bodyFields = ['publicationSite']
    await assert.rejects(loadSpec(doc, fetch), /patch\/1: bodyFields names properties the request body does not declare: publicationSite/)
  })
  it('refuses an inherited object property name', async () => {
    const doc = structuredClone(views)
    doc.paths['/things/{id}'].patch['x-agent'][0].bodyFields = ['title', 'constructor']
    await assert.rejects(loadSpec(doc, fetch), /patch\/0: bodyFields names properties the request body does not declare: constructor/)
  })
  it('refuses bodyFields on an operation without a JSON request body', async () => {
    const doc = structuredClone(views)
    doc.paths['/things/{id}'].get = { operationId: 'getThing', 'x-agent': { name: 'get_thing', bodyFields: ['title'] }, responses: { 200: { description: 'ok' } } }
    await assert.rejects(loadSpec(doc, fetch), /get: bodyFields needs a JSON or multipart request body that is an object with properties/)
  })
})

describe('resolveBody', () => {
  it('prefers JSON, then multipart, then a raw file body', () => {
    assert.equal(resolveBody({ content: { 'multipart/form-data': { schema: { type: 'object' } }, 'application/json': { schema: { type: 'object' } } } })?.kind, 'json')
    assert.deepEqual(
      resolveBody({ required: true, content: { 'multipart/form-data': { schema: { type: 'object' }, encoding: { file: { contentType: 'text/csv, application/zip' }, title: {} } } } }),
      { kind: 'multipart', schema: { type: 'object' }, required: true, encoding: { file: ['text/csv', 'application/zip'] } }
    )
    assert.deepEqual(
      resolveBody({ content: { 'text/csv': {}, 'application/x-ndjson': {} } }),
      { kind: 'file', schema: {}, required: false, mediaTypes: ['text/csv', 'application/x-ndjson'] }
    )
  })
  it('leaves out, as before, the JSON-like and form bodies it does not send', () => {
    assert.equal(resolveBody({ content: { 'application/merge-patch+json': { schema: {} } } }), undefined)
    assert.equal(resolveBody({ content: { 'application/x-www-form-urlencoded': { schema: {} } } }), undefined)
    assert.equal(resolveBody(undefined), undefined)
  })
})

describe('loadSpec — multipart bodies', () => {
  const multipartDoc = (agent: Record<string, unknown>) => ({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/uploads': {
        post: {
          operationId: 'upload',
          'x-agent': agent,
          requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, title: { type: 'string' } } } } } },
          responses: {}
        }
      }
    }
  })
  it('accepts bodyFields naming multipart parts', async () => {
    await assert.doesNotReject(loadSpec(multipartDoc({ name: 'upload', bodyFields: ['file'] }), fetch))
  })
  it('refuses body: compact on a multipart body', async () => {
    await assert.rejects(loadSpec(multipartDoc({ name: 'upload', body: 'compact' }), fetch), /post: body: compact needs a JSON request body \(this one is multipart\/form-data\)/)
  })
})

describe('loadSpec — bodyRequired checked on every view', () => {
  it('refuses a property the view does not offer', async () => {
    const doc = structuredClone(views)
    doc.paths['/things/{id}'].patch['x-agent'][1].bodyRequired = ['title']
    await assert.rejects(loadSpec(doc, fetch), /patch\/1: bodyRequired names properties the tool does not offer: title/)
  })
  it('accepts a property of the allow-list, or of the whole body without one', async () => {
    const doc = structuredClone(views)
    doc.paths['/things/{id}'].patch['x-agent'][1].bodyRequired = ['publicationSites']
    await assert.doesNotReject(loadSpec(doc, fetch))
    const single = structuredClone(views)
    single.paths['/things/{id}'].patch['x-agent'] = { name: 'update_thing', bodyRequired: ['description'] }
    await assert.doesNotReject(loadSpec(single, fetch))
  })
  it('refuses bodyRequired on an operation without a request body', async () => {
    const doc = structuredClone(views)
    doc.paths['/things/{id}'].get = { operationId: 'getThing', 'x-agent': { name: 'get_thing', bodyRequired: ['title'] }, responses: { 200: { description: 'ok' } } }
    await assert.rejects(loadSpec(doc, fetch), /get: bodyRequired needs a JSON or multipart request body that is an object with properties/)
  })
})
