import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'
import { instructions } from '../src/adapters/server.ts'
import { toolsForScopes } from '../src/scopes.ts'

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
  it('produces the eight form tools', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'form_describeState', 'form_editArray', 'form_getData',
      'form_getFieldSuggestions', 'form_reloadForm', 'form_saveForm',
      'form_setData', 'form_setFieldValue'
    ].sort())
  })

  it('every tool of a one-form group carries the operation\'s security', async () => {
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

  it('every tool takes form and the write operation path parameters', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    for (const tool of tools) {
      assert.deepEqual(tool.inputSchema.properties.form.enum, ['item'])
      assert.equal(tool.inputSchema.properties.id !== undefined, true, `${tool.name} should take id`)
      assert.equal(tool.inputSchema.properties.lineId !== undefined, true, `${tool.name} should take lineId`)
    }
  })

  it('opens a session on first call and describes the fetched schema', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const describe = tools.find(t => t.name === 'form_describeState')!
    const result = await describe.execute({ form: 'item', id: 'cities', lineId: 'abc' })
    assert.equal(result.isError, undefined)
    assert.match(result.text, /Nom/)
  })

  it('resumes the same session for the same record', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'form_setFieldValue')!
    const get = tools.find(t => t.name === 'form_getData')!
    await set.execute({ form: 'item', id: 'cities', lineId: 'abc', path: '/nom', value: 'Brest' })
    const result = await get.execute({ form: 'item', id: 'cities', lineId: 'abc' })
    assert.match(result.text, /Brest/)
  })

  it('publishes the tools and skill of a form that saves', async () => {
    const { tools, skills } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'form_setFieldValue')!
    assert.ok(set.inputSchema.properties.save, 'writes take the save option')
    const skill = skills.find(s => s.tools?.includes('form_saveForm'))!
    assert.match(skill.body!, /until you save them/)
    assert.doesNotMatch(skill.body!, /read-only/)
  })

  it('empties the form of a create editor after each save, for the next record', async () => {
    const create = structuredClone(doc) as any
    delete create.paths['/collections/{id}/lines/{lineId}'].put['x-agent'].editor.readOperation
    const { tools } = await load(create, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'form_setFieldValue')!
    const get = tools.find(t => t.name === 'form_getData')!
    const save = tools.find(t => t.name === 'form_saveForm')!
    calls.length = 0
    await set.execute({ form: 'item', id: 'new', lineId: 'l1', path: '/nom', value: 'Brest' })
    const saved = await save.execute({ form: 'item', id: 'new', lineId: 'l1' })
    assert.equal(saved.isError, undefined, saved.text)
    assert.deepEqual(calls.filter(c => c.method === 'PUT').map(c => JSON.parse(c.body!)), [{ nom: 'Brest' }])
    assert.doesNotMatch((await get.execute({ form: 'item', id: 'new', lineId: 'l1' })).text, /Brest/)
  })

  it('appends the group guide to the instructions', async () => {
    const toolSet = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.match(instructions(toolSet), /item/)
  })

  it('publishes form-neutral descriptions, the form titles in the form argument', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    for (const tool of tools) {
      assert.doesNotMatch(tool.description, /Edit a record|FORMTITLESENTINEL/, tool.name)
      assert.match(tool.inputSchema.properties.form.description, /"item": Edit a record/)
    }
    assert.equal(tools.find(t => t.name === 'form_saveForm')!.annotations.title, 'Edit a record — save')
  })

  it('partitions sessions by identity and sends each call with its own headers', async () => {
    const { tools } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'form_setFieldValue')!
    const get = tools.find(t => t.name === 'form_getData')!
    calls.length = 0
    await set.execute({ form: 'item', id: 'ds', lineId: 'l1', path: '/nom', value: 'Brest' }, { identity: 'alice', headers: { cookie: 'who=alice' } })
    const bob = await get.execute({ form: 'item', id: 'ds', lineId: 'l1' }, { identity: 'bob', headers: { cookie: 'who=bob' } })
    assert.match(bob.text, /Rennes/, "bob's session loads the record, not alice's edit")
    assert.doesNotMatch(bob.text, /Brest/)
    const cookies = calls.map(c => c.cookie)
    assert.ok(cookies.includes('who=alice') && cookies.includes('who=bob'), `each session fetched with its caller's headers: ${cookies}`)
    const alice = await get.execute({ form: 'item', id: 'ds', lineId: 'l1' }, { identity: 'alice' })
    assert.match(alice.text, /Brest/, "alice's session keeps her edit")
  })

  // json-layout's `fetch` option answers the parsed body, not a Response: handed a Response,
  // every getItems URL failed with "getItems didn't return an array" (2026-10-28 smoke).
  it('suggests the items of a getItems URL, fetched with the caller\'s headers', async () => {
    const suggestCalls: { url: string, cookie: string | null }[] = []
    const schema = {
      type: 'object',
      properties: {
        commune: {
          type: 'string',
          title: 'Commune',
          layout: { getItems: { url: 'https://api.test/v1/communes?q={q}', itemKey: 'data.code', itemTitle: 'data.nom', itemsResults: 'data.results' } }
        }
      }
    }
    const suggestFetch = (async (input: Request) => {
      suggestCalls.push({ url: input.url, cookie: input.headers.get('cookie') })
      if (input.url.includes('/schema')) return new Response(JSON.stringify(schema), { headers: { 'content-type': 'application/json' } })
      if (input.url.includes('/communes')) return new Response(JSON.stringify({ results: [{ code: '44162', nom: 'Saint-Herblain' }] }), { headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof globalThis.fetch
    const { tools } = await load(doc, { fetch: suggestFetch, baseUrl: 'https://api.test/v1' })
    const suggest = tools.find(t => t.name === 'form_getFieldSuggestions')!
    const result = await suggest.execute({ form: 'item', id: 'ds', lineId: 'l1', path: '/commune', query: 'herblain' }, { identity: 'alice', headers: { cookie: 'who=alice' } })
    assert.equal(result.isError, undefined, result.text)
    assert.match(result.text, /44162/)
    assert.match(result.text, /Saint-Herblain/)
    const items = suggestCalls.find(c => c.url.includes('/communes'))
    assert.equal(items?.url, 'https://api.test/v1/communes?q=herblain')
    assert.equal(items?.cookie, 'who=alice')
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
    const skill = skills.find(s => s.name === 'form')
    assert.ok(skill, `an editor group skill is published (have ${skills.map(s => s.name).join(', ')})`)
    assert.match(skill.body, /Social links take an identifier, not a URL\./)
    assert.match(skill.body, /form_describeState/)
    assert.match(skill.body, /form_saveForm/)
    assert.match(skill.body, /## About Edit a portal configuration \(form: "portal_config"\)/)
    assert.match(skill.body, /- `portal_config`: Edit a portal configuration \(id\)/)
    assert.doesNotMatch(skill.body, /FORMTITLESENTINEL/)
    assert.ok(skill.description.length > 0 && skill.description.length <= 1024)
    assert.equal(calls.length, 0, 'the skill of a declared schema needs no request')
  })

  it('publishes a generic skill when the schema is only known per record', async () => {
    const { skills } = await load(doc, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const skill = skills.find(s => s.name === 'form')
    assert.ok(skill)
    assert.match(skill.body, /form_describeState/)
    assert.doesNotMatch(skill.body, /## About this/)
  })
})

describe('editor group over several operations', () => {
  const multi = structuredClone(doc) as any
  multi.paths['/collections/{id}/lines/{lineId}'].put.security = [{ oauth2: ['lines:write'] }]
  multi.paths['/settings/{id}'] = {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    get: { operationId: 'readSettings', responses: { 200: { description: 'ok' } } },
    put: {
      operationId: 'updateSettings',
      security: [{ oauth2: ['settings:write'] }],
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { color: { type: 'string' } } } } } },
      responses: { 200: { description: 'ok' } },
      'x-agent': { name: 'settings', title: { en: 'Settings' }, description: { en: 'Secret fields read masked.' }, editor: { readOperation: 'readSettings' } }
    }
  }

  it('publishes one group of eight tools and one skill for every form', async () => {
    const { tools, skills } = await load(multi, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.equal(tools.length, 8)
    const set = tools.find(t => t.name === 'form_setFieldValue')!
    assert.deepEqual(set.inputSchema.properties.form.enum, ['item', 'settings'])
    assert.deepEqual(set.inputSchema.required, ['form', 'id', 'path'])
    assert.equal(set.annotations.title, 'Form — set a field')
    assert.deepEqual(skills.map(s => s.name), ['form'])
    assert.match(skills[0].description, /Forms: "item": Edit a record; "settings": Settings\./)
    assert.match(skills[0].body, /- `settings`: Settings \(id\)\. Secret fields read masked\./)
  })

  it('keeps one session per form and document', async () => {
    const { tools } = await load(multi, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'form_setFieldValue')!
    const get = tools.find(t => t.name === 'form_getData')!
    await set.execute({ form: 'settings', id: 'cities', path: '/color', value: 'red' })
    assert.match((await get.execute({ form: 'settings', id: 'cities' })).text, /red/)
    assert.doesNotMatch((await get.execute({ form: 'item', id: 'cities', lineId: 'abc' })).text, /red/)
  })

  it('narrows the form argument to the forms a token\'s scopes grant', async () => {
    const toolSet = await load(multi, { fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const scoped = toolsForScopes(toolSet, ['settings:write'])
    assert.equal(scoped.tools.length, 8)
    const set = scoped.tools.find(t => t.name === 'form_setFieldValue')!
    assert.deepEqual(set.inputSchema.properties.form.enum, ['settings'])
    assert.equal(set.annotations.title, 'Settings — set a field')
    assert.match((await set.execute({ form: 'item', id: 'c', lineId: 'l', path: '/nom', value: 'x' })).text, /must name one of the forms/)
    assert.deepEqual(toolsForScopes(toolSet, ['other']).tools, [])
    assert.deepEqual(toolsForScopes(toolSet, ['other']).skills, [])
  })
})
