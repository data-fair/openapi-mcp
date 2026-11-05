import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'
import { loadSpec } from '../src/spec.ts'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'
import { createMcpServer } from '../src/adapters/mcp.ts'

const doc = (response: Record<string, unknown>) => ({
  openapi: '3.1.0',
  info: { title: 'Preview', version: '1' },
  servers: [{ url: 'https://preview.example/api' }],
  paths: {
    '/preview': {
      get: {
        operationId: 'getPreview',
        'x-agent': { name: 'get_preview', response },
        responses: {
          200: {
            description: 'ok',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['image', 'text', 'report'],
                  properties: {
                    image: { type: 'object', properties: { data: { type: 'string' }, mediaType: { type: 'string' } } },
                    text: { type: 'string' },
                    report: { type: 'object', properties: { verdict: { type: 'string' } } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
})

const body = { image: { data: 'aGk=', mediaType: 'image/png' }, text: '### Page\n- Verdict: ok', report: { verdict: 'ok' } }
const fetchFn = (async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as typeof fetch
const nofetch = (async () => new Response('{}')) as typeof fetch

describe('response.image', () => {
  it('returns the image apart from the text, which has no base64', async () => {
    const ts = await load(doc({ image: '/image' }), { fetch: fetchFn, structuredContent: true })
    const res = await ts.tools[0].execute({})
    assert.deepEqual(res.image, { data: 'aGk=', mimeType: 'image/png' })
    assert.match(res.text, /verdict/i)
    assert.ok(!res.text.includes('aGk='))
    assert.ok(!JSON.stringify(res.structuredContent).includes('aGk='))
  })
  it('does not declare the image in the output schema', async () => {
    const ts = await load(doc({ image: '/image', text: '/text' }), { fetch: fetchFn, structuredContent: true })
    assert.deepEqual(Object.keys((ts.tools[0].outputSchema as any).properties), ['report'])
    assert.deepEqual((ts.tools[0].outputSchema as any).required, ['report'])
  })
  it('refuses file combined with image', async () => {
    await assert.rejects(loadSpec(doc({ image: '/image', file: true }), nofetch), /response\.image cannot be combined with response\.file/)
  })
  it('refuses a pointer that does not resolve', async () => {
    await assert.rejects(loadSpec(doc({ image: '/nope' }), nofetch), /get_preview: response\.image "\/nope" does not resolve/)
  })
  it('refuses an image without data and mediaType strings', async () => {
    const d: any = doc({ image: '/text' })
    await assert.rejects(loadSpec(d, nofetch), /response\.image "\/text" does not resolve/)
  })
})

describe('response.text', () => {
  it('returns the string verbatim and the body without image and text as structured content', async () => {
    const ts = await load(doc({ image: '/image', text: '/text' }), { fetch: fetchFn, structuredContent: true })
    const res = await ts.tools[0].execute({})
    assert.equal(res.text, '### Page\n- Verdict: ok')
    assert.deepEqual(res.structuredContent, { report: { verdict: 'ok' } })
    assert.deepEqual(res.image, { data: 'aGk=', mimeType: 'image/png' })
  })
  it('refuses a pointer that does not resolve, and file combined with text', async () => {
    await assert.rejects(loadSpec(doc({ image: '/image', text: '/nope' }), nofetch), /get_preview: response\.text "\/nope" does not resolve/)
    await assert.rejects(loadSpec(doc({ text: '/text', file: true }), nofetch), /response\.text cannot be combined with response\.file/)
  })
  it('emits the image part after the text part through MCP', async () => {
    const ts = await load(doc({ image: '/image', text: '/text' }), { fetch: fetchFn })
    const server = await createMcpServer(ts, { name: 'test', version: '0.0.0' })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client({ name: 'client', version: '0.0.0' })
    await client.connect(ct)
    const res: any = await client.callTool({ name: 'get_preview', arguments: {} })
    assert.deepEqual(res.content[0], { type: 'text', text: '### Page\n- Verdict: ok' })
    assert.deepEqual(res.content[1], { type: 'image', data: 'aGk=', mimeType: 'image/png' })
  })
})
