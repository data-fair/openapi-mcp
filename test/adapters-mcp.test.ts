import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server as HttpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { load } from '../src/load.ts'
import { createComposer } from '../src/compose.ts'
import { createMcpServer, createMcpHttpHandler } from '../src/adapters/mcp.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
const upstream: Request[] = []
const fetchFn = (async (input: RequestInfo | URL) => {
  const req = input as Request
  upstream.push(req)
  if (req.url.includes('/pets/')) return new Response('# Rex', { headers: { 'content-type': 'text/markdown' } })
  return new Response(JSON.stringify({ total: 1, results: [{ id: 'p1', name: 'Rex' }] }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const INFO = { name: 'test', version: '0.0.0' }
const SkillsList = z.object({ skills: z.array(z.any()), ttlMs: z.number().optional(), cacheScope: z.string().optional() }).passthrough()

async function inMemory () {
  const toolSet = await load(petstore, { fetch: fetchFn })
  const server = await createMcpServer(toolSet, INFO)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'client', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, toolSet }
}

describe('mcp adapter over a tool set (in-memory, 2025 era)', () => {
  it('lists tools with schemas, annotations, examples and instructions', async () => {
    const { client, toolSet } = await inMemory()
    assert.equal(client.getInstructions(), toolSet.instructions)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.equal(tools[0].inputSchema.type, 'object')
    assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false })
    assert.deepEqual(tools[0]._meta, { 'anthropic/inputExamples': [{ query: 'rex', size: 5 }] })
    assert.deepEqual(client.getServerCapabilities()?.extensions, { 'io.modelcontextprotocol/skills': {} })
  })
  it('calls tools, reports validation errors and unknown tools as isError', async () => {
    const { client } = await inMemory()
    const ok: any = await client.callTool({ name: 'pets_list_pets', arguments: { query: 'rex' } })
    assert.match(ok.content[0].text, /\| p1 \| Rex \|/)
    const md: any = await client.callTool({ name: 'pets_get_pet', arguments: { id: 'p1' } })
    assert.equal(md.content[0].text, '# Rex')
    const bad: any = await client.callTool({ name: 'pets_list_pets', arguments: { size: 999 } })
    assert.equal(bad.isError, true)
    const nope: any = await client.callTool({ name: 'nope', arguments: {} })
    assert.equal(nope.isError, true)
  })
  it('serves skills as resources and through skills/list + skills/get, digest matching the bytes', async () => {
    const { client } = await inMemory()
    const { resources } = await client.listResources()
    assert.deepEqual(resources.map(r => [r.uri, r.mimeType]), [['skill://workflow/SKILL.md', 'text/markdown']])
    const listed = await client.request({ method: 'skills/list', params: {} }, SkillsList)
    const entry = listed.skills[0]
    assert.deepEqual(entry.frontmatter, { name: 'workflow', description: 'Start with list_pets, then get_pet.' })
    assert.equal(listed.ttlMs, 300000)
    const read = await client.readResource({ uri: entry.uri })
    const text = (read.contents[0] as any).text as string
    assert.match(text, /^---\nname: workflow\n/)
    assert.deepEqual(entry.resources, [{ uri: entry.uri, digest: 'sha256:' + createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) }])
    const got = await client.request({ method: 'skills/get', params: { uri: entry.uri } }, z.object({ skill: z.any() }).passthrough())
    assert.deepEqual(got.skill, entry)
    await assert.rejects(client.request({ method: 'skills/get', params: { uri: 'skill://nope/SKILL.md' } }, z.any()), (err: any) => err.code === -32602)
    await assert.rejects(client.readResource({ uri: 'skill://nope/SKILL.md' }), (err: any) => err.code === -32602)
  })
})

describe('mcp adapter over a composer (HTTP, both eras)', () => {
  const docs = new Map<string, unknown>([['https://idx.test/index.json', { version: 1, services: [{ id: 'pets', openapi: 'https://pets.test/openapi.json' }] }], ['https://pets.test/openapi.json', petstore]])
  const stackFetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (docs.has(url)) return new Response(JSON.stringify(docs.get(url)), { headers: { 'content-type': 'application/json', etag: `"${JSON.stringify(docs.get(url)).length}"` } })
    return fetchFn(input)
  }) as typeof fetch
  let http: HttpServer
  let url: URL
  let composer: Awaited<ReturnType<typeof createComposer>>
  const contexts: (Request | undefined)[] = []

  before(async () => {
    composer = await createComposer('https://idx.test/index.json', { fetch: stackFetch })
    const handler = createMcpHttpHandler(composer, INFO, {
      context: (request) => { contexts.push(request); return { headers: { cookie: request?.headers.get('cookie') ?? '' }, identity: request?.headers.get('cookie') ?? undefined } },
      refreshMs: 60_000
    })
    http = createServer(toNodeHandler(handler))
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    url = new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`)
  })
  after(() => http.close())

  const connect = async (mode: 'legacy' | 'auto', target = url, headers: Record<string, string> = {}, listChanged?: () => void) => {
    const client = new Client({ name: 'c', version: '0' }, {
      versionNegotiation: { mode },
      ...(listChanged ? { listChanged: { tools: { debounceMs: 0, onChanged: () => listChanged() } } } : {})
    })
    await client.connect(new StreamableHTTPClientTransport(target, { requestInit: { headers } }))
    return client
  }

  it('serves a 2025 client unchanged', async () => {
    const client = await connect('legacy')
    assert.equal(client.getProtocolEra(), 'legacy')
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    await client.close()
  })
  it('serves a 2026-07-28 client with cache hints', async () => {
    const client = await connect('auto')
    assert.equal(client.getProtocolEra(), 'modern')
    const list = await client.listTools()
    assert.equal(list.ttlMs, 60_000)
    assert.equal(list.cacheScope, 'private')
    assert.equal(client.getInstructions(), (await composer.compose()).toolSet.instructions)
    await client.close()
  })
  it('selects the profile set from ?profiles= and rejects an undeclared one', async () => {
    const client = await connect('auto', new URL(`${url}?profiles=edit`))
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_create_pet'])
    await client.close()
    await assert.rejects(async () => {
      const c = await connect('legacy', new URL(`${url}?profiles=nope`))
      await c.listTools()
    })
  })
  it('hands the request to the context hook and forwards the derived headers upstream', async () => {
    upstream.length = 0
    const client = await connect('auto', url, { cookie: 'id_token=abc' })
    await client.callTool({ name: 'pets_list_pets', arguments: {} })
    assert.equal(upstream.at(-1)!.headers.get('cookie'), 'id_token=abc')
    assert.ok(contexts.some(r => r?.headers.get('cookie') === 'id_token=abc'))
    await client.close()
  })
  it('notifies a modern client when a refresh changes the set', async () => {
    let fired = () => {}
    const changed = new Promise<void>(resolve => { fired = resolve })
    const client = await connect('auto', url, {}, () => fired())
    await client.listTools()
    docs.set('https://pets.test/openapi.json', { ...petstore, paths: { ...petstore.paths, '/pets': { ...petstore.paths['/pets'], get: { ...petstore.paths['/pets'].get, 'x-agent': { ...petstore.paths['/pets'].get['x-agent'], name: 'find_pets' } } } } })
    assert.equal(await composer.refresh(), true)
    await Promise.race([changed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('no tools/list_changed within 2s')), 2000))])
    const { tools } = await client.listTools()
    assert.ok(tools.some(t => t.name === 'pets_find_pets'))
    await client.close()
  })
})
