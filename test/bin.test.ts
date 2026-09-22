import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
let port = 0
const api = createServer((req, res) => {
  if (req.url === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ...petstore, servers: [{ url: `http://127.0.0.1:${port}/api` }] }))
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ total: 1, results: [{ id: 'p1', name: 'Rex' }], apiKey: req.headers['x-apikey'] }))
})

describe('standalone server', () => {
  before(async () => { await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve)); port = (api.address() as any).port })
  after(() => api.close())

  it('serves tools over stdio and forwards the API key header', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../src/bin/server.ts', import.meta.url))],
      env: { ...process.env, OPENAPI_URL: `http://127.0.0.1:${port}/openapi.json`, API_KEY_HEADER: 'x-apiKey', API_KEY: 'secret', TRANSPORT: 'stdio' }
    })
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(transport)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    const res: any = await client.callTool({ name: 'pets_list_pets', arguments: { response_format: 'detailed' } })
    assert.match(res.content[0].text, /apiKey\*\*: secret/)
    await client.close()
  })
})
