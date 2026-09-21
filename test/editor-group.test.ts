import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  'x-agent': { profiles: { write: { description: 'write' } } },
  paths: {
    '/datasets/{id}/schema': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'readSchema', parameters: [{ name: 'mimeType', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } }
    },
    '/datasets/{id}/lines/{lineId}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineId', in: 'path', required: true, schema: { type: 'string' } }
      ],
      get: { operationId: 'readLine', responses: { 200: { description: 'ok' } } },
      put: {
        operationId: 'updateLine',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'ok' } },
        'x-agent': {
          profiles: ['write'],
          name: 'dataset_line',
          title: { en: 'Edit a record' },
          editor: { schemaOperation: 'readSchema', schemaParams: { mimeType: 'application/schema+json' }, readOperation: 'readLine' }
        }
      }
    }
  }
}

const LINE_SCHEMA = { type: 'object', required: [], properties: { nom: { type: 'string', title: 'Nom' } } }

const calls: { method: string, url: string, body?: string }[] = []
const fetchFn = (async (input: Request) => {
  calls.push({ method: input.method, url: input.url, body: input.body ? await input.clone().text() : undefined })
  if (input.url.includes('/schema')) return new Response(JSON.stringify(LINE_SCHEMA), { headers: { 'content-type': 'application/json' } })
  if (input.method === 'GET') return new Response(JSON.stringify({ nom: 'Rennes' }), { headers: { 'content-type': 'application/json' } })
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
}) as unknown as typeof globalThis.fetch

describe('editor tool group', () => {
  it('produces eight tools named after the operation', async () => {
    const { tools } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'dataset_line_describeState', 'dataset_line_editArray', 'dataset_line_getData',
      'dataset_line_getFieldSuggestions', 'dataset_line_reloadForm', 'dataset_line_saveForm',
      'dataset_line_setData', 'dataset_line_setFieldValue'
    ].sort())
  })

  it('makes no HTTP request while building the tools', async () => {
    calls.length = 0
    await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.equal(calls.length, 0, 'descriptors must be published without touching the API')
  })

  it('every tool takes the write operation path parameters', async () => {
    const { tools } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    for (const tool of tools) {
      assert.equal(tool.inputSchema.properties.id !== undefined, true, `${tool.name} should take id`)
      assert.equal(tool.inputSchema.properties.lineId !== undefined, true, `${tool.name} should take lineId`)
    }
  })

  it('opens a session on first call and describes the fetched schema', async () => {
    const { tools } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const describe = tools.find(t => t.name === 'dataset_line_describeState')!
    const result = await describe.execute({ id: 'communes', lineId: 'abc' })
    assert.equal(result.isError, undefined)
    assert.match(result.text, /Nom/)
  })

  it('resumes the same session for the same record', async () => {
    const { tools } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'dataset_line_setFieldValue')!
    const get = tools.find(t => t.name === 'dataset_line_getData')!
    await set.execute({ id: 'communes', lineId: 'abc', path: '/nom', value: 'Brest' })
    const result = await get.execute({ id: 'communes', lineId: 'abc' })
    assert.match(result.text, /Brest/)
  })

  it('appends the group guide to the instructions', async () => {
    const { instructions } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.match(instructions, /dataset_line/)
  })
})
