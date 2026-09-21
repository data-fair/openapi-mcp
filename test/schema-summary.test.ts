import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { summariseSchema } from '../src/schema-summary.ts'
import { load } from '../src/load.ts'

describe('summariseSchema — property lines', () => {
  it('marks optional properties with ? and required ones without', () => {
    const out = summariseSchema({ type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'number' } } })
    assert.equal(out, 'a: string\nb?: number')
  })
  it('renders arrays as item[]', () => {
    const out = summariseSchema({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } })
    assert.equal(out, 'tags?: string[]')
  })
  it('inlines an enum', () => {
    const out = summariseSchema({ type: 'object', properties: { m: { type: 'string', enum: ['avg', 'sum'] } } })
    assert.equal(out, 'm?: "avg"|"sum"')
  })
  it('keeps a short description on the line', () => {
    const out = summariseSchema({ type: 'object', properties: { title: { type: 'string', description: 'Dataset title' } } })
    assert.equal(out, 'title?: string — Dataset title')
  })
  it('truncates a long description', () => {
    const out = summariseSchema({ type: 'object', properties: { d: { type: 'string', description: 'x'.repeat(200) } } })
    assert.ok(out.length < 130, `line was ${out.length} chars`)
    assert.match(out, /…$/)
  })
})

describe('summariseSchema — enum truncation', () => {
  it('elides a long enum and says how many there were', () => {
    const out = summariseSchema({ type: 'object', properties: { f: { type: 'string', enum: Array.from({ length: 18 }, (_, i) => `v${i}`) } } })
    assert.match(out, /… \(18 values\)/)
    assert.ok(out.length < 160, `line was ${out.length} chars`)
  })
  it('lists a short enum in full', () => {
    assert.equal(summariseSchema({ type: 'object', properties: { f: { type: 'string', enum: ['a', 'b'] } } }), 'f?: "a"|"b"')
  })
})

describe('summariseSchema — nullable unwrapping', () => {
  it('unwraps oneOf [T, null] so the real type shows', () => {
    const out = summariseSchema({
      type: 'object',
      properties: { s: { oneOf: [{ type: 'string' }, { type: 'null' }] } }
    })
    assert.equal(out, 's?: string | null')
  })
  it('expands an object hidden behind a nullable oneOf', () => {
    const out = summariseSchema({
      type: 'object',
      properties: {
        temporal: { oneOf: [{ type: 'object', properties: { start: { type: 'string' } } }, { type: 'null' }] }
      }
    }, { maxDepth: 1 })
    assert.match(out, /temporal\?: object \| null/)
    assert.match(out, /^ {2}start\?: string$/m)
  })
})

describe('summariseSchema — depth', () => {
  const nested = {
    type: 'object',
    properties: {
      a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' } } } } }
    }
  }
  it('collapses nested objects by default — depth is the expensive knob', () => {
    const out = summariseSchema(nested)
    assert.equal(out, 'a?: object')
  })
  it('expands one level when asked, collapsing deeper', () => {
    const out = summariseSchema(nested, { maxDepth: 1 })
    assert.match(out, /^a\?: object$/m)
    assert.match(out, /^ {2}b\?: object$/m)
    assert.ok(!/c\?:/.test(out), 'depth 2 should be collapsed')
  })
  it('honours maxDepth', () => {
    assert.match(summariseSchema(nested, { maxDepth: 2 }), /^ {4}c\?: string$/m)
  })
  it('expands objects inside arrays', () => {
    const out = summariseSchema({
      type: 'object',
      properties: { rows: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' } } } } }
    }, { maxDepth: 1 })
    assert.match(out, /^rows\?: object\[\]$/m)
    assert.match(out, /^ {2}key\?: string$/m)
  })
})

describe('summariseSchema — the real data-fair datasetPatch', () => {
  it('turns 26KB of schema into a listing an agent can read', async () => {
    const doc = JSON.parse(await readFile(new URL('./fixtures/data-fair-root.json', import.meta.url), 'utf8'))
    const schema = doc.components.schemas.datasetPatch
    const raw = JSON.stringify(schema).length
    const out = summariseSchema(schema)

    assert.ok(raw > 20000, `fixture drifted: raw schema is ${raw} chars`)
    assert.ok(out.length < 3000, `summary was ${out.length} chars, expected well under the raw ${raw}`)
    assert.ok(out.split('\n').length === 35, `expected the 35 top-level properties, got ${out.split('\n').length} lines`)
    assert.match(out, /^title\?: string/m)
    assert.match(out, /^keywords\?: string\[\]/m)
    assert.match(out, /^frequency\?: /m)
    assert.ok(!out.includes('"layout"'), 'layout keywords must not survive into the summary')
  })
})

describe('load — body: "compact"', () => {
  const spec = (body: 'flat' | 'compact') => ({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://x.example' }],
    paths: {
      '/things/{id}': {
        put: {
          operationId: 'putThing',
          parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
          'x-agent': { profiles: true, name: 'put_thing', body },
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['title'],
                  properties: {
                    title: { type: 'string', description: 'Short title' },
                    count: { type: 'number' },
                    tags: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          },
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } }
        }
      }
    }
  })

  const stub = (handler: (req: Request) => Response) => {
    const calls: Request[] = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init)
      calls.push(req)
      return handler(req)
    }) as typeof fetch
    return { fetchFn, calls }
  }
  const ok = () => new Response(JSON.stringify({ id: 'x' }), { headers: { 'content-type': 'application/json' } })

  it('exposes one body property carrying the listing, not the merged schema', async () => {
    const ts = await load(spec('compact'), { fetch: stub(ok).fetchFn })
    const props = ts.tools[0].inputSchema.properties
    assert.deepEqual(Object.keys(props).sort(), ['body', 'id'])
    assert.match(props.body.description, /title: string — Short title/)
    assert.match(props.body.description, /tags\?: string\[\]/)
    assert.deepEqual(ts.tools[0].inputSchema.required, ['id', 'body'])
  })

  it('still merges flat by default, so nothing existing changes', async () => {
    const ts = await load(spec('flat'), { fetch: stub(ok).fetchFn })
    assert.deepEqual(Object.keys(ts.tools[0].inputSchema.properties).sort(), ['count', 'id', 'tags', 'title'])
  })

  it('rejects a malformed body locally, with a path, before any request', async () => {
    const { fetchFn, calls } = stub(ok)
    const ts = await load(spec('compact'), { fetch: fetchFn })
    const res = await ts.tools[0].execute({ id: 'x', body: { title: 42 } })
    assert.equal(res.isError, true)
    assert.match(res.text, /^Invalid body: \/title must be string/)
    assert.equal(calls.length, 0, 'no HTTP request should be made')
  })

  it('rejects a body missing a required property', async () => {
    const ts = await load(spec('compact'), { fetch: stub(ok).fetchFn })
    const res = await ts.tools[0].execute({ id: 'x', body: { count: 1 } })
    assert.equal(res.isError, true)
    assert.match(res.text, /Invalid body: .*title/)
  })

  it('sends a valid body through as the request payload', async () => {
    const { fetchFn, calls } = stub(ok)
    const ts = await load(spec('compact'), { fetch: fetchFn })
    const res = await ts.tools[0].execute({ id: 'x', body: { title: 'hello', tags: ['a'] } })
    assert.equal(res.isError, undefined)
    assert.equal(calls[0].method, 'PUT')
    assert.equal(calls[0].url, 'https://x.example/things/x')
    assert.deepEqual(await calls[0].json(), { title: 'hello', tags: ['a'] })
  })
})
