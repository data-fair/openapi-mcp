import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOperationById } from '../src/spec.ts'
import { resolveEditorOperations } from '../src/editor/operations.ts'
import { buildSessionSpec, createSchemaRegistry } from '../src/editor/session-spec.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
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
        'x-agent': { name: 'dataset_line', title: { en: 'Edit a record' }, editor: { schemaOperation: 'readSchema', schemaParams: { mimeType: 'application/schema+json' }, readOperation: 'readLine' } }
      }
    }
  }
}

const LINE_SCHEMA = { type: 'object', required: [], properties: { nom: { type: 'string', title: 'Nom' } } }

function harness (overrides: Record<string, unknown> = {}) {
  const calls: { method: string, url: string, body?: string }[] = []
  const fetchFn = (async (input: Request) => {
    calls.push({ method: input.method, url: input.url, body: input.body ? await input.clone().text() : undefined })
    if (input.url.includes('/schema')) return new Response(JSON.stringify(overrides.schema ?? LINE_SCHEMA), { headers: { 'content-type': 'application/json' } })
    if (input.method === 'GET') return new Response(JSON.stringify({ nom: 'Rennes' }), { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  const ctx = { doc, baseUrl: 'https://api.test/v1', fetch: fetchFn, locale: 'en' }
  const ops = resolveEditorOperations(resolveOperationById(doc, 'updateLine')!, doc)
  return { calls, ctx, ops, registry: createSchemaRegistry() }
}

describe('buildSessionSpec', () => {
  it('loads the document through readOperation', async () => {
    const { calls, ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    assert.deepEqual(await spec.load(), { data: { nom: 'Rennes' }, version: undefined })
    assert.equal(new URL(calls[0].url).pathname, '/v1/datasets/communes/lines/abc')
  })

  it('makes no request when there is no readOperation — a create', async () => {
    const { calls, ctx, registry } = harness()
    const op = resolveOperationById(doc, 'updateLine')!
    op.agent.editor = { schemaOperation: 'readSchema' }
    const ops = resolveEditorOperations(op, doc)
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    assert.deepEqual(await spec.load(), { data: {}, version: undefined })
    assert.equal(calls.length, 0)
  })

  it('fetches the schema with schemaParams applied and prepares it', async () => {
    const { calls, ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    const { schema, version } = await spec.schema()
    assert.equal(schema.properties.nom.type, 'string')
    assert.equal(typeof version, 'string')
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, '/v1/datasets/communes/schema')
    assert.equal(url.searchParams.get('mimeType'), 'application/schema+json')
  })

  it('never sends an arrays parameter', async () => {
    const { calls, ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    await spec.schema()
    assert.equal(new URL(calls[0].url).searchParams.has('arrays'), false)
  })

  it('hands two sessions over the same dataset the same schema function', () => {
    const { ctx, ops, registry } = harness()
    const a: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    const b: any = buildSessionSpec(ops, { id: 'communes', lineId: 'zzz' }, ctx, registry)
    assert.equal(a.schema, b.schema, 'same dataset must share one closure, or the layout recompiles per line')
  })

  it('hands two datasets different schema functions', () => {
    const { ctx, ops, registry } = harness()
    const a: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    const b: any = buildSessionSpec(ops, { id: 'autre', lineId: 'abc' }, ctx, registry)
    assert.notEqual(a.schema, b.schema)
  })

  it('reports a version that changes when the schema changes', async () => {
    const one = harness()
    const two = harness({ schema: { type: 'object', properties: { autre: { type: 'string' } } } })
    const specA: any = buildSessionSpec(one.ops, { id: 'communes', lineId: 'abc' }, one.ctx, one.registry)
    const specB: any = buildSessionSpec(two.ops, { id: 'communes', lineId: 'abc' }, two.ctx, two.registry)
    assert.notEqual((await specA.schema()).version, (await specB.schema()).version)
  })

  it('saves the whole document through the write operation', async () => {
    const { calls, ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    await spec.save({ nom: 'Brest' }, {})
    const put = calls.find(c => c.method === 'PUT')!
    assert.equal(new URL(put.url).pathname, '/v1/datasets/communes/lines/abc')
    assert.equal(put.body, JSON.stringify({ nom: 'Brest' }))
  })

  it('reports an API error rather than swallowing it', async () => {
    const ctx = { doc, baseUrl: 'https://api.test/v1', locale: 'en', fetch: (async () => new Response('nope', { status: 403 })) as unknown as typeof globalThis.fetch }
    const ops = resolveEditorOperations(resolveOperationById(doc, 'updateLine')!, doc)
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, createSchemaRegistry())
    await assert.rejects(() => spec.save({ nom: 'Brest' }, {}), /403/)
  })

  it('carries the localized title', () => {
    const { ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    assert.equal(spec.title, 'Edit a record')
    assert.equal(spec.prefixName, 'dataset_line_')
  })
})
