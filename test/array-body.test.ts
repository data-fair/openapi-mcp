import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'
import { load } from '../src/load.ts'
import { createMcpServer } from '../src/adapters/mcp.ts'

const values = { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, count: { type: 'integer' } } } }
const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  servers: [{ url: 'http://x/api' }],
  paths: {
    '/values': {
      get: {
        operationId: 'listValues',
        'x-agent': { description: 'List the values of a field.' },
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: values } } } }
      }
    }
  }
}
const body = [{ value: 'a', count: 2 }]
const fetchFn = (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as typeof fetch

describe('an array response body', () => {
  it('becomes an object structuredContent, with a matching outputSchema, text unchanged', async () => {
    const ts = await load(doc, { fetch: fetchFn, structuredContent: true })
    assert.deepEqual(ts.tools[0].outputSchema, { type: 'object', properties: { results: values }, required: ['results'] })
    const res = await ts.tools[0].execute({})
    assert.deepEqual(res.structuredContent, { results: body })
    const plain = await (await load(doc, { fetch: fetchFn })).tools[0].execute({})
    assert.equal(res.text, plain.text)
    assert.equal(plain.structuredContent, undefined)
  })
  it('succeeds through the MCP adapter', async () => {
    const server = await createMcpServer(await load(doc, { fetch: fetchFn, structuredContent: true }), { name: 't', version: '0' })
    const [c, s] = InMemoryTransport.createLinkedPair()
    await server.connect(s)
    const client = new Client({ name: 'c', version: '0' })
    await client.connect(c)
    const res: any = await client.callTool({ name: 'list_values', arguments: {} })
    assert.notEqual(res.isError, true)
    assert.deepEqual(res.structuredContent, { results: body })
  })
})
