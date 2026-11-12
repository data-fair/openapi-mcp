import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'

/** fetch stub recording requests and answering from a handler */
function stub (handler: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    calls.push(req)
    return handler(req)
  }) as typeof fetch
  return { fetchFn, calls }
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })

const titled = { type: 'object', properties: { _id: { type: 'string' }, title: { type: 'string' } } }
const ok = (schema: unknown = titled) => ({ 200: { description: 'ok', content: { 'application/json': { schema } } } })

/** Pages shown on portals, as the portals API: an attach takes a page id and a list of portal ids. */
const doc = (labels: Record<string, unknown> = {
  id: { name: 'pageTitle', operation: 'getPage', field: '/title' },
  portals: { name: 'portalTitles', operation: 'getPortal', field: '/title' }
}): any => ({
  openapi: '3.1.0',
  info: { title: 'portals', version: '1' },
  servers: [{ url: 'https://portals.example/api' }],
  paths: {
    '/pages/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getPage', responses: ok() },
      patch: {
        operationId: 'patchPage',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { portals: { type: 'array', items: { type: 'string' } }, title: { type: 'string' } } } } } },
        responses: ok(),
        'x-agent': { name: 'attach_page_to_portals', bodyFields: ['portals'], bodyRequired: ['portals'], labels }
      }
    },
    '/portals/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'getPortal', responses: ok() }
    }
  }
})

const records: Record<string, { _id: string, title: string }> = {
  '/api/pages/p1': { _id: 'p1', title: 'Agenda culturel de l\'été' },
  '/api/portals/agglo': { _id: 'agglo', title: 'Portail de l\'agglomération' },
  '/api/portals/intranet': { _id: 'intranet', title: 'Intranet des agents' }
}
const api = () => stub(req => {
  const path = new URL(req.url).pathname
  if (req.method === 'GET') return records[path] ? json(records[path]) : json({ error: 'not found' }, 404)
  return json({ _id: 'p1', title: 'Agenda culturel de l\'été' })
})
const writes = (calls: Request[]) => calls.filter(c => c.method !== 'GET')

describe('checked labels', () => {
  it('adds a label input beside each id, marked x-checked and required with it', async () => {
    const ts = await load(doc(), { fetch: api().fetchFn })
    const schema = ts.tools[0].inputSchema
    assert.deepEqual(schema.required, ['id', 'portals', 'pageTitle', 'portalTitles'])
    assert.equal(schema.properties.pageTitle.type, 'string')
    assert.deepEqual(schema.properties.pageTitle['x-checked'], { against: 'id', field: '/title' })
    assert.deepEqual(schema.properties.portalTitles, {
      type: 'array',
      items: { type: 'string' },
      description: schema.properties.portalTitles.description,
      'x-checked': { against: 'portals', field: '/title' }
    })
    assert.match(schema.properties.portalTitles.description, /^The title of each item of `portals`, in the same order/)
  })

  it('reads each resource, then sends the call without the labels', async () => {
    const { fetchFn, calls } = api()
    const ts = await load(doc(), { fetch: fetchFn })
    const res = await ts.tools[0].execute({ id: 'p1', pageTitle: 'Agenda culturel de l\'été', portals: ['agglo'], portalTitles: [' Portail de  l\'agglomération '] })
    assert.equal(res.isError, undefined, res.text)
    assert.deepEqual(calls.map(c => `${c.method} ${new URL(c.url).pathname}`).sort(), ['GET /api/pages/p1', 'GET /api/portals/agglo', 'PATCH /api/pages/p1'])
    assert.deepEqual(await writes(calls)[0].json(), { portals: ['agglo'] })
  })

  it('refuses a label that is not its id\'s, before anything is written', async () => {
    const { fetchFn, calls } = api()
    const ts = await load(doc(), { fetch: fetchFn })
    const res = await ts.tools[0].execute({ id: 'p1', pageTitle: 'Agenda culturel de l\'été', portals: ['intranet'], portalTitles: ['Portail de l\'agglomération'] })
    assert.equal(res.isError, true)
    assert.equal(res.text, '"portals" item 0 (intranet) is "Intranet des agents", not "Portail de l\'agglomération"; nothing was sent. Check that the id is the one you meant, and give its title as the API returns it.')
    assert.equal(writes(calls).length, 0)
  })

  it('refuses one label per id missing, and an id it cannot read', async () => {
    const { fetchFn, calls } = api()
    const ts = await load(doc(), { fetch: fetchFn })
    const counted = await ts.tools[0].execute({ id: 'p1', pageTitle: 'Agenda culturel de l\'été', portals: ['agglo', 'intranet'], portalTitles: ['Portail de l\'agglomération'] })
    assert.match(counted.text, /^"portalTitles" must give one title per item of "portals" \(2\), in the same order; nothing was sent\.$/)
    const unknown = await ts.tools[0].execute({ id: 'nope', pageTitle: 'x', portals: ['agglo'], portalTitles: ['Portail de l\'agglomération'] })
    assert.match(unknown.text, /^Could not read the title of "id" \(nope\) to check "pageTitle" \(HTTP 404\); nothing was sent\.$/)
    assert.equal(writes(calls).length, 0)
  })

  it('reads with the call\'s own context', async () => {
    const { fetchFn, calls } = api()
    const ts = await load(doc({ id: { name: 'pageTitle', operation: 'getPage', field: '/title' } }), { fetch: fetchFn })
    await ts.tools[0].execute({ id: 'p1', pageTitle: 'Agenda culturel de l\'été', portals: [] }, { headers: { cookie: 'id_token=abc' } })
    assert.ok(calls.length === 2 && calls.every(c => c.headers.get('cookie') === 'id_token=abc'))
  })

  it('requires the label of an optional id only when the id is given', async () => {
    const d = doc()
    delete d.paths['/pages/{id}'].patch['x-agent'].bodyRequired
    const { fetchFn, calls } = api()
    const ts = await load(d, { fetch: fetchFn })
    assert.deepEqual(ts.tools[0].inputSchema.required, ['id', 'pageTitle'])
    assert.deepEqual(ts.tools[0].inputSchema.dependentRequired, { portals: ['portalTitles'] })
    const missing = await ts.tools[0].execute({ id: 'p1', pageTitle: 'Agenda culturel de l\'été', portals: ['agglo'] })
    assert.match(missing.text, /^Invalid parameters: .*portalTitles/)
    assert.equal(writes(calls).length, 0)
  })

  it('refuses a document whose label cannot be checked', async () => {
    const bad = (labels: Record<string, unknown>) => load(doc(labels), { fetch: api().fetchFn })
    await assert.rejects(bad({ id: { name: 'pageTitle', operation: 'nope', field: '/title' } }), /attach_page_to_portals: labels\.id names "nope", which is not an operation in this document/)
    await assert.rejects(bad({ id: { name: 'pageTitle', operation: 'patchPage', field: '/title' } }), /labels\.id names "patchPage", a PATCH: a label is read with a GET/)
    await assert.rejects(bad({ id: { name: 'pageTitle', operation: 'getPage', field: '/name' } }), /labels\.id: field "\/name" is not in the response schema of "getPage"/)
    await assert.rejects(bad({ owner: { name: 'ownerName', operation: 'getPage', field: '/title' } }), /labels\.owner checks an input the tool does not have/)
    await assert.rejects(bad({ id: { name: 'portals', operation: 'getPage', field: '/title' } }), /labels\.id: "portals" is already an input of attach_page_to_portals/)
    await assert.rejects(bad({ id: { name: 'pageTitle', operation: 'getPage' } }), /x-agent invalid/)
  })
})
