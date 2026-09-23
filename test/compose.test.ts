import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createComposer, compose } from '../src/compose.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
const vetstore = JSON.parse(await readFile(new URL('./fixtures/vetstore.json', import.meta.url), 'utf8'))

/**
 * An HTTP stub keyed by URL with ETags: a request whose If-None-Match equals the current
 * ETag gets a 304. `set` replaces a document and bumps its ETag.
 */
function stack () {
  const docs = new Map<string, { body: unknown, etag: string }>()
  const hits: Record<string, number> = {}
  let counter = 0
  const set = (url: string, body: unknown) => docs.set(url, { body, etag: `"${++counter}"` })
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    hits[req.url] = (hits[req.url] ?? 0) + 1
    const doc = docs.get(req.url)
    if (!doc) return new Response('not found', { status: 404 })
    if (req.headers.get('if-none-match') === doc.etag) return new Response(null, { status: 304, headers: { etag: doc.etag } })
    return new Response(JSON.stringify(doc.body), { headers: { 'content-type': 'application/json', etag: doc.etag } })
  }) as typeof fetch
  return { set, fetchFn, hits }
}

const INDEX = 'https://idx.test/index.json'
const PETS = 'https://pets.test/openapi.json'
const VETS = 'https://vets.test/openapi.json'

function base () {
  const s = stack()
  s.set(INDEX, {
    version: 1,
    services: [{ id: 'pets', openapi: PETS }, { id: 'vets', openapi: VETS }],
    profiles: { explore: { title: 'Explore everything' }, full: { title: 'Full', includes: ['explore', 'edit'] } },
    skills: [{ name: 'cross-booking', description: 'Find a pet, then book a vet.', profiles: ['edit'] }]
  })
  s.set(PETS, petstore)
  s.set(VETS, vetstore)
  return s
}

describe('createComposer', () => {
  it('merges the services in index order for one profile, and lists the union of profiles', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'])
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet', 'vets_list_vets'])
    assert.deepEqual(c.toolSet.profiles, ['explore'])
    assert.deepEqual(c.services.map(x => [x.id, x.status, x.tools]), [['pets', 'ok', 2], ['vets', 'ok', 1]])
    assert.match(c.toolSet.instructions, /^# Pets\n\n## workflow/)
    assert.doesNotMatch(c.toolSet.instructions, /cross-booking/, 'an edit-only index skill is not in the explore set')
    assert.deepEqual(c.toolSet.skills.map(x => x.id), ['pets/workflow'])
    const profiles = composer.profiles()
    assert.deepEqual(profiles.map(p => [p.name, p.title, p.services]), [
      ['explore', 'Explore everything', ['pets', 'vets']],
      ['full', 'Full', []],
      ['edit', 'Edit', ['pets', 'vets']],
      ['edit_appointments', 'Edit appointments', ['vets']]
    ])
    assert.deepEqual(profiles.find(p => p.name === 'full')!.includes, ['explore', 'edit'])
  })

  it('selects a set once per operation, expanding document and index includes', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const full = await composer.compose(['full'])
    assert.deepEqual(full.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_create_pet', 'pets_get_pet', 'vets_list_vets', 'vets_create_appointment'])
    assert.deepEqual(full.toolSet.skills.map(x => x.id), ['cross-booking', 'pets/workflow', 'pets/editing', 'vets/booking'])
    assert.match(full.toolSet.instructions, /^## cross-booking\n\nFind a pet, then book a vet\.\n\n# Pets/)
    assert.equal(await composer.compose(['full']), full, 'memoized per distinct set')
    assert.equal(await composer.compose(['edit', 'explore']), await composer.compose(['explore', 'edit']))
  })

  it('skips a service declaring none of the requested profiles, and defaults to the index default', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['edit_appointments'])
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['vets_create_appointment'])
    assert.deepEqual(c.services.map(x => [x.id, x.status, x.reason]), [['pets', 'skipped', 'declares none of [edit_appointments]'], ['vets', 'ok', undefined]])
    assert.deepEqual((await composer.compose()).toolSet.profiles, ['explore'])
    assert.deepEqual((await composer.compose([])).toolSet.profiles, ['explore'])
  })

  it('serves a partial set when a service fails, and throws only on a bad index', async () => {
    const s = base()
    s.set(VETS, { openapi: '3.1.0', info: { title: 'Broken', version: '1' }, 'x-agent': { skills: [{ name: 'Bad Name', description: 'd' }] }, paths: {} })
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'])
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.equal(c.services[1].status, 'error')
    assert.match(c.services[1].reason!, /x-agent invalid/)
    await assert.rejects(createComposer('https://idx.test/missing.json', { fetch: s.fetchFn }), /HTTP 404/)
    s.set(INDEX, { version: 2, services: [] })
    await assert.rejects(createComposer(INDEX, { fetch: s.fetchFn }), /index invalid: \/version/)
  })

  it('excludes the later service on a tool name collision, naming both', async () => {
    const s = base()
    s.set(VETS, { ...vetstore, 'x-agent': { ...vetstore['x-agent'], namePrefix: 'pets_' }, paths: { '/vets': { get: { ...vetstore.paths['/vets'].get, 'x-agent': { profiles: ['explore'], name: 'list_pets' } } } } })
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'])
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.deepEqual(c.services[1], { id: 'vets', openapi: VETS, status: 'error', tools: 0, reason: 'tool name collision with pets: pets_list_pets' })
  })

  it('refreshes with conditional requests, rebuilding only what changed, and notifies once', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'])
    let notified = 0
    c.onChange(() => notified++)
    let composerNotified = 0
    composer.onChange(() => composerNotified++)

    assert.equal(await composer.refresh(), false)
    assert.deepEqual([s.hits[INDEX], s.hits[PETS], s.hits[VETS]], [2, 2, 2], 'every document revalidated, none rebuilt')
    assert.equal(notified, 0)

    s.set(VETS, { ...vetstore, paths: { ...vetstore.paths, '/vets': { get: { ...vetstore.paths['/vets'].get, 'x-agent': { profiles: ['explore'], name: 'list_all_vets', description: 'List vets.' } } } } })
    assert.equal(await composer.refresh(), true)
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet', 'vets_list_all_vets'])
    assert.equal(notified, 1)
    assert.equal(composerNotified, 1)

    // a new ETag over unchanged bytes is not a change of the set
    s.set(PETS, petstore)
    assert.equal(await composer.refresh(), false)
    assert.equal(notified, 1)

    // the index itself changes: a service is removed
    s.set(INDEX, { version: 1, services: [{ id: 'pets', openapi: PETS }] })
    assert.equal(await composer.refresh(), true)
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.deepEqual(composer.services.map(x => x.id), ['pets'])
  })

  it('fetches each document once however many sets are composed, and executes through the call context', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    await composer.compose(['explore']); await composer.compose(['edit']); await composer.compose(['full'])
    assert.deepEqual([s.hits[PETS], s.hits[VETS]], [1, 1])
    const seen: Request[] = []
    const upstream = (async (input: RequestInfo | URL) => { seen.push(input as Request); return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } }) }) as typeof fetch
    const tool = (await composer.compose(['explore'])).toolSet.tools.find(t => t.name === 'vets_list_vets')!
    await tool.execute({}, { fetch: upstream, headers: { cookie: 'c=1' } })
    assert.equal(seen[0].url, 'https://vets.example/api/vets')
    assert.equal(seen[0].headers.get('cookie'), 'c=1')
  })

  it('compose() is the one-shot convenience', async () => {
    const s = base()
    const c = await compose(INDEX, { fetch: s.fetchFn, profiles: ['edit'] })
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_create_pet', 'vets_create_appointment'])
  })

  it('restricts a composition to some services and overrides the prefix — a compatibility route', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'], { services: ['pets'], namePrefix: '' })
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['list_pets', 'get_pet'])
    assert.deepEqual(c.services.map(x => x.id), ['pets'], 'only the listed services are composed')
    assert.equal(await composer.compose(['explore'], { services: ['pets'], namePrefix: '' }), c, 'memoized with its options')
    assert.notEqual(await composer.compose(['explore']), c)
    assert.deepEqual((await composer.compose(['explore'])).toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet', 'vets_list_vets'])

    const legacy = await createComposer(INDEX, { fetch: s.fetchFn, namePrefix: 'legacy_' })
    assert.deepEqual((await legacy.compose(['explore'])).toolSet.tools.map(t => t.name), ['legacy_list_pets', 'legacy_get_pet', 'legacy_list_vets'], 'a compose() call with no override keeps the composer-level namePrefix')
  })
})
