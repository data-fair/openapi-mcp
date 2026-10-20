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
import type { ToolSet } from '../src/types.ts'
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

async function inMemory (given?: ToolSet) {
  const toolSet = given ?? await load(petstore, { fetch: fetchFn })
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
    assert.deepEqual(tools.map(t => t.name), ['list_pets', 'create_pet', 'get_pet'])
    assert.equal(tools[0].inputSchema.type, 'object')
    assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false })
    assert.deepEqual(tools[0]._meta, { 'anthropic/inputExamples': [{ query: 'rex', size: 5 }] })
    assert.deepEqual(client.getServerCapabilities()?.extensions, { 'io.modelcontextprotocol/skills': {} })
  })
  it('calls tools, reports validation errors and unknown tools as isError', async () => {
    const { client } = await inMemory()
    const ok: any = await client.callTool({ name: 'list_pets', arguments: { query: 'rex' } })
    assert.match(ok.content[0].text, /\| p1 \| Rex \|/)
    const md: any = await client.callTool({ name: 'get_pet', arguments: { id: 'p1' } })
    assert.equal(md.content[0].text, '# Rex')
    const bad: any = await client.callTool({ name: 'list_pets', arguments: { size: 999 } })
    assert.equal(bad.isError, true)
    const nope: any = await client.callTool({ name: 'nope', arguments: {} })
    assert.equal(nope.isError, true)
  })
  it('serves skills as resources and through skills/list + skills/get, digest matching the bytes', async () => {
    const { client } = await inMemory()
    const { resources } = await client.listResources()
    assert.deepEqual(resources.map(r => [r.uri, r.mimeType]), [['skill://workflow/SKILL.md', 'text/markdown'], ['skill://editing/SKILL.md', 'text/markdown']])
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
  it('lists a skill whose body failed as a resource that answers an error, and leaves it out of skills/list', async () => {
    const toolSet = await load({
      ...structuredClone(petstore),
      servers: [{ url: 'https://api.test/v1' }],
      'x-agent': { ...petstore['x-agent'], skills: [{ name: 'ok', description: 'Fine.' }, { name: 'gone', description: 'Broken.', href: 'gone.md' }] }
    }, { fetch: (async () => new Response('no', { status: 404 })) as unknown as typeof fetch })
    const { client } = await inMemory(toolSet)
    const { resources } = await client.listResources()
    assert.deepEqual(resources.map(r => r.uri), ['skill://ok/SKILL.md', 'skill://gone/SKILL.md'])
    const listed = await client.request({ method: 'skills/list', params: {} }, SkillsList)
    assert.deepEqual(listed.skills.map((s: any) => s.frontmatter.name), ['ok'])
    await assert.rejects(client.readResource({ uri: 'skill://gone/SKILL.md' }), (err: any) => /HTTP 404 \(https:\/\/api\.test\/v1\/gone\.md\)/.test(err.message))
    await assert.rejects(client.request({ method: 'skills/get', params: { uri: 'skill://gone/SKILL.md' } }, z.any()), (err: any) => err.code === -32602)
  })
})

describe('mcp adapter over HTTP (both eras)', () => {
  let http: HttpServer
  let url: URL
  let all: ToolSet
  let current: ToolSet
  let handler: ReturnType<typeof createMcpHttpHandler>
  const contexts: (Request | undefined)[] = []

  before(async () => {
    all = current = await load(petstore, { fetch: fetchFn })
    handler = createMcpHttpHandler(() => current, INFO, {
      context: (request) => { contexts.push(request); return { headers: { cookie: request?.headers.get('cookie') ?? '' }, identity: request?.headers.get('cookie') ?? undefined } },
      cacheTtlMs: 60_000
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
    assert.deepEqual(tools.map(t => t.name), ['list_pets', 'create_pet', 'get_pet'])
    await client.close()
  })
  it('serves a 2026-07-28 client with cache hints', async () => {
    const client = await connect('auto')
    assert.equal(client.getProtocolEra(), 'modern')
    const list = await client.listTools()
    assert.equal(list.ttlMs, 60_000)
    assert.equal(list.cacheScope, 'private')
    assert.equal(client.getInstructions(), all.instructions)
    await client.close()
  })
  it('hands the request to the context hook and forwards the derived headers upstream', async () => {
    upstream.length = 0
    const client = await connect('auto', url, { cookie: 'id_token=abc' })
    await client.callTool({ name: 'list_pets', arguments: {} })
    assert.equal(upstream.at(-1)!.headers.get('cookie'), 'id_token=abc')
    assert.ok(contexts.some(r => r?.headers.get('cookie') === 'id_token=abc'))
    await client.close()
  })
  it('notifies a modern client when its owner says the set changed', async () => {
    let fired = () => {}
    const changed = new Promise<void>(resolve => { fired = resolve })
    const client = await connect('auto', url, {}, () => fired())
    await client.listTools()
    current = { ...all, tools: all.tools.filter(t => t.name !== 'create_pet') }
    handler.notify.toolsChanged()
    await Promise.race([changed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('no tools/list_changed within 2s')), 2000))])
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['list_pets', 'get_pet'])
    current = all
    await client.close()
  })
})

describe('mcp adapter with a request-dependent source', () => {
  it('picks the source per request and leaves change notifications to the caller', async () => {
    const all = await load(petstore, { fetch: fetchFn })
    const readOnly: ToolSet = { ...all, tools: all.tools.filter(t => t.annotations?.readOnlyHint) }
    const handler = createMcpHttpHandler((request) => new URL(request!.url).pathname.endsWith('/read') ? readOnly : all, INFO)
    const http = createServer(toNodeHandler(handler))
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const port = (http.address() as any).port
    try {
      for (const [path, names] of [['/mcp', ['list_pets', 'create_pet', 'get_pet']], ['/read', ['list_pets', 'get_pet']]] as const) {
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } })
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`)))
        assert.deepEqual((await client.listTools()).tools.map(t => t.name), names)
        await client.close()
      }
      assert.equal(typeof handler.notify.toolsChanged, 'function')
    } finally {
      http.close()
    }
  })
})

const files = JSON.parse(await readFile(new URL('./fixtures/files.json', import.meta.url), 'utf8'))

describe('mcp adapter — files', () => {
  it('sends a resource_link after the text block', async () => {
    upstream.length = 0
    const { client } = await inMemory(await load(files, { fetch: fetchFn }))
    const res: any = await client.callTool({ name: 'export_lines', arguments: { id: 'rge' } })
    const uri = 'https://files.example/api/datasets/rge/lines?format=csv'
    assert.deepEqual(res.content, [
      { type: 'text', text: `File rge-lines.csv (text/csv), not downloaded by this tool: ${uri}` },
      { type: 'resource_link', uri, name: 'rge-lines.csv', mimeType: 'text/csv' }
    ])
    assert.equal(upstream.some(r => r.url.includes('/lines')), false)
  })
  it('lists file inputs with their x-mcp-file marker when a file store is configured', async () => {
    const { client } = await inMemory(await load(files, { fetch: fetchFn, files: { urlPrefixes: ['https://s3.test/bucket/'] } }))
    const { tools } = await client.listTools()
    const create = tools.find(t => t.name === 'create_dataset')!
    assert.deepEqual((create.inputSchema.properties as any).file['x-mcp-file'], { accept: ['text/csv', 'application/vnd.ms-excel'], maxSize: 104857600 })
  })
})
