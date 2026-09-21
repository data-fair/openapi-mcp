import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lintToolInput } from '../src/vocabulary/lint.ts'
import { load } from '../src/load.ts'

const schema = (props: Record<string, any>) => ({ type: 'object', properties: props, additionalProperties: false })

describe('lintToolInput — scalar example for an array parameter', () => {
  it('flags a quoted scalar example on an array param (the live sort bug)', () => {
    const f = lintToolInput('aggregate_data', schema({
      sort: { type: 'array', items: { type: 'string' }, description: 'Per aggregation level: "count"/"-count". Example: "-count".' }
    }), new Set(['sort']))
    assert.equal(f.length, 1)
    assert.equal(f[0].param, 'sort')
    assert.equal(f[0].rule, 'scalar-example-for-array')
    assert.match(f[0].message, /array/)
  })
  it('accepts an array-shaped example', () => {
    assert.deepEqual(lintToolInput('t', schema({
      sort: { type: 'array', items: { type: 'string' }, description: 'Array of sort keys, e.g. ["-count"].' }
    }), new Set(['sort'])), [])
  })
  it('accepts a quoted scalar on a scalar param', () => {
    assert.deepEqual(lintToolInput('t', schema({
      metric: { type: 'string', description: 'Metric to compute, e.g. "avg".' }
    }), new Set(['metric'])), [])
  })
})

describe('lintToolInput — comma-separated said of an array', () => {
  it('flags it (the live search_data bug)', () => {
    const f = lintToolInput('search_data', schema({
      sort: { type: 'array', items: { type: 'string' }, description: 'Comma-separated column keys, prefix with - for descending.' }
    }), new Set(['sort']))
    assert.equal(f.length, 1)
    assert.equal(f[0].rule, 'comma-separated-array')
  })
  it('accepts comma-separated on a string param', () => {
    assert.deepEqual(lintToolInput('t', schema({
      percents: { type: 'string', description: 'Comma-separated percentages.' }
    }), new Set(['percents'])), [])
  })
})

describe('lintToolInput — quoted value absent from the enum', () => {
  it('flags a quoted value the enum does not allow', () => {
    const f = lintToolInput('t', schema({
      metric: { type: 'string', enum: ['avg', 'sum'], description: 'Use "avg", "sum" or "median".' }
    }), new Set(['metric']))
    assert.equal(f.length, 1)
    assert.equal(f[0].rule, 'quoted-value-not-in-enum')
    assert.match(f[0].message, /median/)
  })
  it('reads an enum on items for an array param', () => {
    assert.deepEqual(lintToolInput('t', schema({
      sort: { type: 'array', items: { type: 'string', enum: ['count', '-count'] }, description: 'Array of keys, e.g. ["-count"].' }
    }), new Set(['sort'])), [])
  })
  it('says nothing when the param has no enum', () => {
    assert.deepEqual(lintToolInput('t', schema({
      q: { type: 'string', description: 'Keywords, e.g. "élus" or "DPE".' }
    }), new Set(['q'])), [])
  })
})

describe('lintToolInput — scope', () => {
  it('ignores descriptions the annotation did not author', () => {
    assert.deepEqual(lintToolInput('t', schema({
      sort: { type: 'array', items: { type: 'string' }, description: 'Comma-separated column keys. Example: "-count".' }
    }), new Set()), [])
  })
  it('reports every offending parameter, not just the first', () => {
    const f = lintToolInput('t', schema({
      a: { type: 'array', items: { type: 'string' }, description: 'Example: "x".' },
      b: { type: 'array', items: { type: 'string' }, description: 'Comma-separated things.' }
    }), new Set(['a', 'b']))
    assert.deepEqual(f.map(x => x.param).sort(), ['a', 'b'])
  })
  it('names the tool on every finding', () => {
    const f = lintToolInput('my_tool', schema({
      a: { type: 'array', items: { type: 'string' }, description: 'Example: "x".' }
    }), new Set(['a']))
    assert.equal(f[0].tool, 'my_tool')
  })
})

describe('load — lint option', () => {
  const spec = (description: string) => ({
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    servers: [{ url: 'https://x.example' }],
    paths: {
      '/things': {
        get: {
          operationId: 'listThings',
          parameters: [{ in: 'query', name: 'sort', schema: { type: 'array', items: { type: 'string' } } }],
          'x-agent': { profiles: true, params: { sort: { description } } },
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } }
        }
      }
    }
  })
  const bad = spec('Sort keys. Example: "-count".')
  const good = spec('Array of sort keys, e.g. ["-count"].')

  it('throws by default, naming the tool, the param and the rule', async () => {
    await assert.rejects(load(bad), (e: Error) => {
      assert.match(e.message, /list_things\.sort \[scalar-example-for-array\]/)
      return true
    })
  })
  it('builds without complaint when the description matches the schema', async () => {
    const ts = await load(good)
    assert.equal(ts.tools.length, 1)
  })
  it('lint: "warn" builds anyway', async () => {
    const ts = await load(bad, { lint: 'warn' })
    assert.equal(ts.tools.length, 1)
  })
  it('lint: "off" builds anyway', async () => {
    const ts = await load(bad, { lint: 'off' })
    assert.equal(ts.tools.length, 1)
  })
  it('does not lint a description inherited from the document', async () => {
    const inherited: any = spec('unused')
    inherited.paths['/things'].get.parameters[0].description = 'Comma-separated keys. Example: "-count".'
    delete inherited.paths['/things'].get['x-agent'].params
    const ts = await load(inherited)
    assert.equal(ts.tools.length, 1)
  })
})
