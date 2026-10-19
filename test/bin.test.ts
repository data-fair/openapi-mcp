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
const bin = fileURLToPath(new URL('../src/bin/server.ts', import.meta.url))
let port = 0
let version = 1
const api = createServer((req, res) => {
  const servers = [{ url: `http://127.0.0.1:${port}/api` }]
  if (req.url === '/gone.md') { res.writeHead(404); return res.end('not found') }
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url === '/openapi.json') return res.end(JSON.stringify({ ...petstore, servers }))
  if (req.url === '/broken-skill.json') {
    return res.end(JSON.stringify({ ...petstore, servers, 'x-agent': { skills: [{ name: 'workflow', description: 'When pets.', href: `http://127.0.0.1:${port}/gone.md` }] } }))
  }
  // a document whose tool names follow `version`: what a refresh picks up
  if (req.url === '/changing.json') {
    const get = { ...petstore.paths['/pets'].get, 'x-agent': { ...petstore.paths['/pets'].get['x-agent'], name: `list_pets_v${version}` } }
    return res.end(JSON.stringify({ ...petstore, servers, paths: { ...petstore.paths, '/pets': { ...petstore.paths['/pets'], get } } }))
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
    const { version: packageVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.deepEqual(client.getServerVersion(), { name: 'openapi-mcp', version: packageVersion })
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['list_pets', 'create_pet', 'get_pet'])
    const res: any = await client.callTool({ name: 'list_pets', arguments: { response_format: 'detailed' } })
    assert.match(res.content[0].text, /apiKey\*\*: secret/)
    await client.close()
  })

  for (const name of ['INDEX_URL', 'PROFILES']) {
    it(`refuses the removed ${name} variable`, async () => {
      const child = spawn(process.execPath, [bin], {
        env: { ...process.env, OPENAPI_URL: `http://127.0.0.1:${port}/openapi.json`, [name]: 'x', TRANSPORT: 'http', PORT: String(await freePort()) },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr!.on('data', (chunk) => { stderr += chunk })
      const code = await new Promise<number | null>(resolve => child.on('exit', resolve))
      assert.equal(code, 1)
      assert.match(stderr, new RegExp(`unknown variable ${name}: openapi-mcp serves one document, set OPENAPI_URL`))
    })
  }

  it('requires OPENAPI_URL', async () => {
    const { OPENAPI_URL: _unset, ...rest } = process.env
    const env = { ...rest, TRANSPORT: 'http' }
    const child = spawn(process.execPath, [bin], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += chunk })
    assert.equal(await new Promise<number | null>(resolve => child.on('exit', resolve)), 1)
    assert.match(stderr, /OPENAPI_URL is required/)
  })

  it('reports at startup a skill whose body cannot be read, and still serves', async () => {
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, OPENAPI_URL: `http://127.0.0.1:${port}/broken-skill.json`, TRANSPORT: 'http', PORT: String(await freePort()), REFRESH_INTERVAL: '0' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no skill warning and listening line on stderr: ${stderr}`)), 10000)
        child.stderr!.on('data', (chunk) => {
          stderr += chunk
          if (stderr.includes(`skill workflow: warning — HTTP 404 (http://127.0.0.1:${port}/gone.md)`) && stderr.includes('listening')) { clearTimeout(timer); resolve() }
        })
      })
    } finally {
      child.kill()
    }
  })

  it('serves over HTTP and refreshes the document on its interval', async () => {
    version = 1
    const httpPort = await freePort()
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, OPENAPI_URL: `http://127.0.0.1:${port}/changing.json`, TRANSPORT: 'http', PORT: String(httpPort), REFRESH_INTERVAL: '0.2' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    await new Promise<void>((resolve, reject) => {
      child.stderr.on('data', (d: Buffer) => { if (d.toString().includes('listening')) resolve() })
      child.on('exit', code => reject(new Error(`bin exited with ${code}`)))
    })
    try {
      const names = async () => {
        const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } })
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`)))
        const { tools } = await client.listTools()
        await client.close()
        return tools.map(t => t.name)
      }
      assert.deepEqual(await names(), ['list_pets_v1', 'create_pet', 'get_pet'])
      version = 2
      const deadline = Date.now() + 5000
      while (!(await names()).includes('list_pets_v2')) {
        if (Date.now() > deadline) throw new Error('the refresh did not pick up the new document within 5s')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } finally {
      child.kill()
    }
  })
})
