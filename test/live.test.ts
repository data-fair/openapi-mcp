import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createLiveDocument } from '../src/live.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
const vetstore = JSON.parse(await readFile(new URL('./fixtures/vetstore.json', import.meta.url), 'utf8'))

/**
 * An HTTP stub keyed by URL with ETags: a request whose If-None-Match equals the current
 * ETag gets a 304. `set` replaces a document and bumps its ETag.
 */
function stack () {
  const docs = new Map<string, { body: unknown, etag: string, text?: boolean }>()
  const hits: Record<string, number> = {}
  const requests: Request[] = []
  let counter = 0
  /** URLs answering a given error status until cleared, whatever their validators */
  const failing = new Map<string, number>()
  const set = (url: string, body: unknown) => docs.set(url, { body, etag: `"${++counter}"` })
  const setText = (url: string, body: string) => docs.set(url, { body, etag: `"${++counter}"`, text: true })
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    requests.push(req)
    hits[req.url] = (hits[req.url] ?? 0) + 1
    const status = failing.get(req.url)
    if (status) return new Response('unavailable', { status })
    const doc = docs.get(req.url)
    if (!doc) return new Response('not found', { status: 404 })
    if (req.headers.get('if-none-match') === doc.etag) return new Response(null, { status: 304, headers: { etag: doc.etag } })
    return doc.text
      ? new Response(doc.body as string, { headers: { 'content-type': 'text/markdown', etag: doc.etag } })
      : new Response(JSON.stringify(doc.body), { headers: { 'content-type': 'application/json', etag: doc.etag } })
  }) as typeof fetch
  return { set, setText, failing, fetchFn, hits, requests }
}

const DOC = 'https://pets.test/openapi.json'
const SKILL = 'https://pets.test/skills/workflow.md'
const withLinkedSkill = (href: string) => ({ ...petstore, 'x-agent': { ...petstore['x-agent'], skills: [{ name: 'workflow', description: 'When pets.', href }] } })

describe('createLiveDocument', () => {
  it('refresh sends If-None-Match and keeps the tool set on 304', async () => {
    const s = stack()
    s.set(DOC, petstore)
    const live = await createLiveDocument(DOC, { fetch: s.fetchFn })
    const first = live.toolSet
    assert.deepEqual(first.tools.map(t => t.name), ['list_pets', 'create_pet', 'get_pet'])
    assert.equal(await live.refresh(), false)
    assert.equal(s.requests.at(-1)!.headers.get('if-none-match'), '"1"')
    assert.equal(live.toolSet, first, 'the same object')
    assert.equal(live.error, undefined)
  })

  it('sends If-Modified-Since when the document carries Last-Modified', async () => {
    const seen: Request[] = []
    const lastModified = 'Mon, 19 Oct 2026 10:00:00 GMT'
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      seen.push(req)
      if (req.headers.get('if-modified-since') === lastModified) return new Response(null, { status: 304 })
      return new Response(JSON.stringify(petstore), { headers: { 'content-type': 'application/json', 'last-modified': lastModified } })
    }) as typeof fetch
    const live = await createLiveDocument(DOC, { fetch: fetchFn })
    assert.equal(await live.refresh(), false)
    assert.equal(seen.length, 2)
  })

  it('throws on a failing first load', async () => {
    const s = stack()
    await assert.rejects(createLiveDocument(DOC, { fetch: s.fetchFn }), /failed to load https:\/\/pets\.test\/openapi\.json: HTTP 404/)
    s.set(DOC, { ...petstore, 'x-agent': { profiles: {} } })
    await assert.rejects(createLiveDocument(DOC, { fetch: s.fetchFn }), /x-agent invalid/)
  })

  it('a failing refresh keeps the previous tool set and sets error', async () => {
    const s = stack()
    s.set(DOC, petstore)
    const live = await createLiveDocument(DOC, { fetch: s.fetchFn })
    const first = live.toolSet
    let notified = 0
    live.onChange(() => notified++)

    s.failing.set(DOC, 503)
    assert.equal(await live.refresh(), false)
    assert.equal(live.toolSet, first)
    assert.equal(live.error, `failed to load ${DOC}: HTTP 503`)

    // a document that answers but no longer loads is a failure too
    s.failing.delete(DOC)
    s.set(DOC, { ...petstore, 'x-agent': { namePrefix: 'pets_' } })
    assert.equal(await live.refresh(), false)
    assert.equal(live.toolSet, first)
    assert.match(live.error!, /x-agent invalid/)

    // the same bytes back under a new ETag: the error clears, nothing changed
    s.set(DOC, petstore)
    assert.equal(await live.refresh(), false)
    assert.equal(live.error, undefined)
    assert.equal(live.toolSet, first)
    assert.equal(notified, 0)
  })

  it('a changed document replaces toolSet and calls onChange once', async () => {
    const s = stack()
    s.set(DOC, petstore)
    const live = await createLiveDocument(DOC, { fetch: s.fetchFn })
    const first = live.toolSet
    const seen: string[][] = []
    const unsubscribe = live.onChange(ts => seen.push(ts.tools.map(t => t.name)))

    s.set(DOC, vetstore)
    assert.equal(await live.refresh(), true)
    assert.notEqual(live.toolSet, first)
    assert.deepEqual(first.tools.map(t => t.name), ['list_pets', 'create_pet', 'get_pet'], 'the previous set is not mutated')
    assert.deepEqual(live.toolSet.tools.map(t => t.name), ['list_vets', 'create_appointment'])
    assert.deepEqual(seen, [['list_vets', 'create_appointment']])

    // a tag guide changes only the instructions
    s.set(DOC, { ...vetstore, tags: [{ name: 'Vets', 'x-agent': { skill: 'Vets are people.' } }], paths: { '/vets': { get: { ...vetstore.paths['/vets'].get, tags: ['Vets'] } }, '/appointments': vetstore.paths['/appointments'] } })
    assert.equal(await live.refresh(), true)
    assert.match(live.toolSet.instructions, /Vets are people\./)
    assert.equal(seen.length, 2)

    unsubscribe()
    s.set(DOC, petstore)
    assert.equal(await live.refresh(), true)
    assert.equal(seen.length, 2, 'an unsubscribed listener is not called')
  })

  it('shares one refresh between overlapping calls', async () => {
    const s = stack()
    s.set(DOC, petstore)
    const live = await createLiveDocument(DOC, { fetch: s.fetchFn })
    s.set(DOC, vetstore)
    let notified = 0
    live.onChange(() => notified++)
    assert.deepEqual(await Promise.all([live.refresh(), live.refresh()]), [true, true])
    assert.equal(s.hits[DOC], 2)
    assert.equal(notified, 1)
  })

  it('skill bodies are revalidated conditionally', async () => {
    const s = stack()
    s.set(DOC, withLinkedSkill('skills/workflow.md'))
    s.setText(SKILL, 'Version 1.')
    const live = await createLiveDocument(DOC, { fetch: s.fetchFn })
    const body = () => live.toolSet.skills.find(x => x.id === 'workflow')!.body
    assert.equal(body(), 'Version 1.')
    let notified = 0
    live.onChange(() => notified++)

    assert.equal(await live.refresh(), false, 'an unchanged body is a 304')
    assert.equal(s.hits[SKILL], 2)
    assert.equal(s.requests.filter(r => r.url === SKILL).at(-1)!.headers.get('if-none-match'), '"2"')

    s.setText(SKILL, 'Version 2.')
    assert.equal(await live.refresh(), true)
    assert.equal(notified, 1)
    assert.equal(body(), 'Version 2.')

    // a link the document dropped is no longer revalidated
    s.set(DOC, petstore)
    assert.equal(await live.refresh(), true)
    const hits = s.hits[SKILL]
    await live.refresh()
    assert.equal(s.hits[SKILL], hits)
  })

  it('recovers a skill body after a transient failure, even when the file did not change', async () => {
    const s = stack()
    s.set(DOC, withLinkedSkill('skills/workflow.md'))
    s.setText(SKILL, 'The body.')
    const live = await createLiveDocument(DOC, { fetch: s.fetchFn })
    const skill = () => live.toolSet.skills.find(x => x.id === 'workflow')!
    s.failing.set(SKILL, 503)
    assert.equal(await live.refresh(), true)
    assert.match(skill().error!, /HTTP 503/)
    assert.equal(live.error, undefined, 'a broken body is the skill\'s error, not the document\'s')
    s.failing.delete(SKILL)
    assert.equal(await live.refresh(), true)
    assert.equal(skill().body, 'The body.')
    assert.equal(skill().error, undefined)
  })

  it('reports an unreachable body on its skill and still serves the document', async () => {
    const s = stack()
    s.set(DOC, withLinkedSkill('skills/gone.md'))
    const live = await createLiveDocument(DOC, { fetch: s.fetchFn })
    assert.equal(live.toolSet.skills[0].error, 'HTTP 404 (https://pets.test/skills/gone.md)')
    assert.equal(live.toolSet.tools.length, 3)
  })

  it('executes tools through the call context', async () => {
    const s = stack()
    s.set(DOC, vetstore)
    const live = await createLiveDocument(DOC, { fetch: s.fetchFn })
    const seen: Request[] = []
    const upstream = (async (input: RequestInfo | URL) => { seen.push(input as Request); return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } }) }) as typeof fetch
    await live.toolSet.tools.find(t => t.name === 'list_vets')!.execute({}, { fetch: upstream, headers: { cookie: 'c=1' } })
    assert.equal(seen[0].url, 'https://vets.example/api/vets')
    assert.equal(seen[0].headers.get('cookie'), 'c=1')
  })
})
