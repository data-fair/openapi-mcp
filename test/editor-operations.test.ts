import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOperationById } from '../src/spec.ts'
import { resolveEditorOperations, editorRequest } from '../src/editor/operations.ts'

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
        'x-agent': { name: 'dataset_line', editor: { schemaOperation: 'readSchema', schemaParams: { mimeType: 'application/schema+json' }, readOperation: 'readLine' } }
      }
    },
    '/other/{otherId}/thing': {
      parameters: [{ name: 'otherId', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'readOther', responses: { 200: { description: 'ok' } } }
    }
  }
}

const writeOp = () => resolveOperationById(doc, 'updateLine')!

describe('resolveEditorOperations', () => {
  it('resolves both named operations and the write operation path params', () => {
    const ops = resolveEditorOperations(writeOp(), doc)
    assert.equal(ops.schema?.operationId, 'readSchema')
    assert.equal(ops.read?.operationId, 'readLine')
    assert.deepEqual(ops.pathParamNames, ['id', 'lineId'])
  })

  it('leaves schema undefined for the editor:true shorthand', () => {
    const op = writeOp()
    op.agent.editor = true
    const ops = resolveEditorOperations(op, doc)
    assert.equal(ops.schema, undefined)
    assert.equal(ops.read, undefined)
  })

  it('throws when a named operation does not exist', () => {
    const op = writeOp()
    op.agent.editor = { schemaOperation: 'noSuchOp' }
    assert.throws(() => resolveEditorOperations(op, doc), /noSuchOp/)
  })

  it('throws when a named operation needs a path param the write operation lacks', () => {
    const op = writeOp()
    op.agent.editor = { schemaOperation: 'readOther' }
    assert.throws(() => resolveEditorOperations(op, doc), /otherId/)
  })

  it('throws when the write operation has no JSON request body', () => {
    const op = resolveOperationById(doc, 'readLine')!
    op.agent.editor = true
    assert.throws(() => resolveEditorOperations(op, doc), /request body/)
  })
})

describe('editorRequest', () => {
  it('places path params and fixed query values', () => {
    const req = editorRequest(resolveOperationById(doc, 'readSchema')!, { id: 'communes' }, { mimeType: 'application/schema+json' }, undefined, 'https://api.test/v1')
    assert.equal(req.method, 'GET')
    assert.equal(new URL(req.url).pathname, '/v1/datasets/communes/schema')
    assert.equal(new URL(req.url).searchParams.get('mimeType'), 'application/schema+json')
  })

  it('sends a JSON body on the write operation', async () => {
    const req = editorRequest(writeOp(), { id: 'communes', lineId: 'abc' }, {}, { nom: 'Rennes' }, 'https://api.test/v1')
    assert.equal(req.method, 'PUT')
    assert.equal(req.headers.get('content-type'), 'application/json')
    assert.deepEqual(await req.json(), { nom: 'Rennes' })
  })
})
