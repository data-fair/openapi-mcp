import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'
import { instructions } from '../src/adapters/server.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/collections/{id}/schema': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'readSchema', parameters: [{ name: 'mimeType', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } }
    },
    '/collections/{id}/lines/{lineId}': {
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
          name: 'item',
          title: { en: 'Edit a record' },
          editor: { schemaOperation: 'readSchema', schemaParams: { mimeType: 'application/schema+json' }, readOperation: 'readLine' }
        }
      }
    }
  }
}

const LINE_SCHEMA = { type: 'object', required: [], properties: { nom: { type: 'string', title: 'Nom' } } }

const calls: { method: string, url: string, body?: string, cookie?: string | null }[] = []
const fetchFn = (async (input: Request) => {
  calls.push({ method: input.method, url: input.url, body: input.body ? await input.clone().text() : undefined, cookie: input.headers.get('cookie') })
  if (input.url.includes('/schema')) return new Response(JSON.stringify(LINE_SCHEMA), { headers: { 'content-type': 'application/json' } })
  if (input.method === 'GET') return new Response(JSON.stringify({ nom: 'Rennes' }), { headers: { 'content-type': 'application/json' } })
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
}) as unknown as typeof globalThis.fetch

describe('editor tool group', () => {
  it('produces eight tools named after the operation', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'item_describeState', 'item_editArray', 'item_getData',
      'item_getFieldSuggestions', 'item_reloadForm', 'item_saveForm',
      'item_setData', 'item_setFieldValue'
    ].sort())
  })

  it('every tool of the group carries the operation\'s security', async () => {
    const security = [{ oauth2: ['collections:write'] }]
    const secured = structuredClone(doc) as any
    secured.paths['/collections/{id}/lines/{lineId}'].put.security = security
    const { tools } = await load(secured, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    for (const tool of tools) assert.deepEqual(tool.security, security, tool.name)
  })

  it('makes no HTTP request while building the tools', async () => {
    calls.length = 0
    await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.equal(calls.length, 0, 'descriptors must be published without touching the API')
  })

  it('every tool takes the write operation path parameters', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    for (const tool of tools) {
      assert.equal(tool.inputSchema.properties.id !== undefined, true, `${tool.name} should take id`)
      assert.equal(tool.inputSchema.properties.lineId !== undefined, true, `${tool.name} should take lineId`)
    }
  })

  it('opens a session on first call and describes the fetched schema', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const describe = tools.find(t => t.name === 'item_describeState')!
    const result = await describe.execute({ id: 'cities', lineId: 'abc' })
    assert.equal(result.isError, undefined)
    assert.match(result.text, /Nom/)
  })

  it('resumes the same session for the same record', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'item_setFieldValue')!
    const get = tools.find(t => t.name === 'item_getData')!
    await set.execute({ id: 'cities', lineId: 'abc', path: '/nom', value: 'Brest' })
    const result = await get.execute({ id: 'cities', lineId: 'abc' })
    assert.match(result.text, /Brest/)
  })

  it('appends the group guide to the instructions', async () => {
    const toolSet = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.match(instructions(toolSet), /item/)
  })

  it('publishes the operation title in every tool description', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    for (const tool of tools) {
      assert.match(tool.description, /Edit a record/, `${tool.name} should carry the operation title`)
      assert.doesNotMatch(tool.description, /"form"/, `${tool.name} should not carry the bootstrap title`)
    }
  })

  it('partitions sessions by identity and sends each call with its own headers', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'item_setFieldValue')!
    const get = tools.find(t => t.name === 'item_getData')!
    calls.length = 0
    await set.execute({ id: 'ds', lineId: 'l1', path: '/nom', value: 'Brest' }, { identity: 'alice', headers: { cookie: 'who=alice' } })
    const bob = await get.execute({ id: 'ds', lineId: 'l1' }, { identity: 'bob', headers: { cookie: 'who=bob' } })
    assert.match(bob.text, /Rennes/, "bob's session loads the record, not alice's edit")
    assert.doesNotMatch(bob.text, /Brest/)
    const cookies = calls.map(c => c.cookie)
    assert.ok(cookies.includes('who=alice') && cookies.includes('who=bob'), `each session fetched with its caller's headers: ${cookies}`)
    const alice = await get.execute({ id: 'ds', lineId: 'l1' }, { identity: 'alice' })
    assert.match(alice.text, /Brest/, "alice's session keeps her edit")
  })
})

// The group's form-filling guide was meant to be served as an MCP skill; while the json-layout
// skill builder was not public, the instructions only said "Tools: …" (2026-09-21 live check).
describe('editor group skill', () => {
  const declaredDoc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/portals/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: { operationId: 'readPortal', responses: { 200: { description: 'ok' } } },
        put: {
          operationId: 'updatePortal',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  'x-agent-guide': 'Social links take an identifier, not a URL.',
                  properties: { linkedin: { type: 'string' } }
                }
              }
            }
          },
          responses: { 200: { description: 'ok' } },
          'x-agent': { name: 'portal_config', title: { en: 'Edit a portal configuration' }, editor: { readOperation: 'readPortal' } }
        }
      }
    }
  }

  it('publishes the fill-form skill of a declared schema, its agent guide included', async () => {
    calls.length = 0
    const { skills } = await load(declaredDoc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const skill = skills.find(s => s.name === 'portal-config')
    assert.ok(skill, `an editor group skill is published (have ${skills.map(s => s.name).join(', ')})`)
    assert.match(skill.body, /Social links take an identifier, not a URL\./)
    assert.match(skill.body, /portal_config_describeState/)
    assert.match(skill.body, /portal_config_saveForm/)
    assert.ok(skill.description.length > 0 && skill.description.length <= 1024)
    assert.equal(calls.length, 0, 'the skill of a declared schema needs no request')
  })

  it('publishes a generic skill when the schema is only known per record', async () => {
    const { skills } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const skill = skills.find(s => s.name === 'item')
    assert.ok(skill)
    assert.match(skill.body, /item_describeState/)
    assert.doesNotMatch(skill.body, /## About this/)
  })
})
