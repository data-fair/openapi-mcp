import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { load } from '../src/load.ts'
import { createMcpServer } from '../src/adapters/mcp.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
const fetchFn = (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url.includes('/pets/')) return new Response('# Rex', { headers: { 'content-type': 'text/markdown' } })
  return new Response(JSON.stringify({ total: 1, results: [{ id: 'p1', name: 'Rex' }] }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch

async function connect () {
  const toolSet = await load(petstore, { fetch: fetchFn })
  const server = createMcpServer(toolSet, { name: 'test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'client', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, toolSet }
}

describe('mcp adapter', () => {
  it('lists tools with schemas, annotations and instructions', async () => {
    const { client, toolSet } = await connect()
    assert.equal(client.getInstructions(), toolSet.instructions)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.equal(tools[0].inputSchema.type, 'object')
    assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false })
    assert.deepEqual(tools[0]._meta, { 'anthropic/inputExamples': [{ query: 'rex', size: 5 }] })
  })
  it('calls a tool and returns text content', async () => {
    const { client } = await connect()
    const res: any = await client.callTool({ name: 'pets_list_pets', arguments: { query: 'rex' } })
    assert.equal(res.isError, undefined)
    assert.match(res.content[0].text, /\| p1 \| Rex \|/)
    const md: any = await client.callTool({ name: 'pets_get_pet', arguments: { id: 'p1' } })
    assert.equal(md.content[0].text, '# Rex')
  })
  it('reports validation errors as isError results', async () => {
    const { client } = await connect()
    const res: any = await client.callTool({ name: 'pets_list_pets', arguments: { size: 999 } })
    assert.equal(res.isError, true)
    assert.match(res.content[0].text, /Invalid parameters/)
  })
  it('rejects unknown tools', async () => {
    const { client } = await connect()
    const res: any = await client.callTool({ name: 'nope', arguments: {} })
    assert.equal(res.isError, true)
  })
})
