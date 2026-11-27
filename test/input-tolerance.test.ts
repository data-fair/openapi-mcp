import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  servers: [{ url: 'http://x/api' }],
  paths: {
    '/things': {
      get: {
        operationId: 'listThings',
        'x-agent': { description: 'List things.' },
        parameters: [
          { name: 'filters', in: 'query', style: 'deepObject', explode: true, schema: { type: 'object', additionalProperties: { type: 'string' } } },
          { name: 'sort', in: 'query', explode: false, schema: { type: 'array', items: { type: 'string' } } },
          { name: 'draft', in: 'query', schema: { type: 'string' } },
          { name: 'size', in: 'query', schema: { type: 'integer' } },
          { name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'integer' } } }
        ],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } }
      }
    }
  }
}
const seen: string[] = []
const fetchFn = (async (input: any) => {
  seen.push(String(input.url ?? input))
  return new Response('{}', { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const tool = (await load(doc, { fetch: fetchFn })).tools[0]
const call = async (params: any) => {
  seen.length = 0
  const res = await tool.execute(params)
  return { res, url: decodeURIComponent(seen[0] ?? '') }
}

describe('tolerant inputs', () => {
  it('sends a number in a string-valued additionalProperties object', async () => {
    const { res, url } = await call({ filters: { capacite_gt: 500 } })
    assert.equal(res.isError, undefined)
    assert.match(url, /[?&]capacite_gt=500/)
  })
  it('splits a comma string where an array of strings is declared', async () => {
    const { res, url } = await call({ sort: '-nom, ville' })
    assert.equal(res.isError, undefined)
    assert.match(url, /sort=-nom,ville/)
  })
  it('sends a boolean for a string parameter as a string', async () => {
    const { res, url } = await call({ draft: true })
    assert.equal(res.isError, undefined)
    assert.match(url, /draft=true/)
  })
  it('does not coerce in other directions', async () => {
    assert.equal((await call({ size: '5' })).res.isError, true)
    assert.equal((await call({ tags: '1,2' })).res.isError, true)
    assert.equal((await call({ sort: 5 })).res.isError, true)
    assert.equal((await call({ filters: { a: { b: 1 } } })).res.isError, true)
    assert.equal(seen.length, 0)
  })
  it('names an unknown parameter', async () => {
    const { res } = await call({ foo: 1 })
    assert.equal(res.isError, true)
    assert.match(res.text, /^Invalid parameters: .*foo/)
  })
})
