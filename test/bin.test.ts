import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
const vetstore = JSON.parse(await readFile(new URL('./fixtures/vetstore.json', import.meta.url), 'utf8'))
const bin = fileURLToPath(new URL('../src/bin/server.ts', import.meta.url))
let port = 0
const api = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url === '/openapi.json') return res.end(JSON.stringify({ ...petstore, servers: [{ url: `http://127.0.0.1:${port}/api` }] }))
  if (req.url === '/vets.json') return res.end(JSON.stringify({ ...vetstore, servers: [{ url: `http://127.0.0.1:${port}/api` }] }))
  if (req.url === '/index.json') {
    return res.end(JSON.stringify({ version: 1, services: [{ id: 'pets', openapi: `http://127.0.0.1:${port}/openapi.json` }, { id: 'vets', openapi: `http://127.0.0.1:${port}/vets.json` }] }))
  }
  res.end(JSON.stringify({ total: 1, results: [{ id: 'p1', name: 'Rex' }], apiKey: req.headers['x-apikey'] }))
})

const freePort = () => new Promise<number>(resolve => {
  const s = createNetServer()
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)) })
})

describe('standalone server', () => {
  before(async () => { await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve)); port = (api.address() as any).port })
  after(() => api.close())

  it('serves tools over stdio and forwards the API key header', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
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

  it('composes an index over stdio with a profile set', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: { ...process.env, INDEX_URL: `http://127.0.0.1:${port}/index.json`, PROFILES: 'explore,edit', TRANSPORT: 'stdio', REFRESH_INTERVAL: '0' }
    })
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(transport)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_list_pets', 'pets_create_pet', 'pets_get_pet', 'vets_list_vets', 'vets_create_appointment'])
    await client.close()
  })

  it('serves an index over HTTP, selecting profiles per request', async () => {
    const httpPort = await freePort()
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, INDEX_URL: `http://127.0.0.1:${port}/index.json`, TRANSPORT: 'http', PORT: String(httpPort), REFRESH_INTERVAL: '0' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    await new Promise<void>((resolve, reject) => {
      child.stderr.on('data', (d: Buffer) => { if (d.toString().includes('listening')) resolve() })
      child.on('exit', code => reject(new Error(`bin exited with ${code}`)))
    })
    try {
      const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } })
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp?profiles=edit`)))
      const { tools } = await client.listTools()
      assert.deepEqual(tools.map(t => t.name), ['pets_create_pet', 'vets_create_appointment'])
      await client.close()
    } finally {
      child.kill()
    }
  })
})
