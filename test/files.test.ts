import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { readFile } from 'node:fs/promises'
import { load } from '../src/load.ts'
import type { FileLoadOptions } from '../src/files.ts'

const filesDoc = JSON.parse(await readFile(new URL('./fixtures/files.json', import.meta.url), 'utf8'))
const accented = Buffer.from('é,1\n')

const sourceHeaders: IncomingHttpHeaders[] = []
let releaseSlow = () => {}
const slowClosed = new Promise<void>(resolve => { releaseSlow = resolve })
const closed = new Set<string>()
const released = async (path: string) => {
  for (let i = 0; i < 100 && !closed.has(path); i++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(closed.has(path), `${path} was not released within 2s`)
}
const source = createServer((req, res) => {
  sourceHeaders.push(req.headers)
  const path = req.url!.split('?')[0]
  if (path === '/files/report.csv') { res.writeHead(200, { 'content-type': 'text/csv', 'content-length': 8 }); return res.end('a,b\n1,2\n') }
  if (path === '/files/lines.ndjson') { res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-length': 8 }); return res.end('{"a":1}\n') }
  if (path === '/files/h%C3%A9t%C3%A9.csv') { res.writeHead(200, { 'content-type': 'text/csv', 'content-length': accented.length }); return res.end(accented) }
  if (path === '/files/big.csv') { res.writeHead(200, { 'content-length': 2000 }); return res.end('x'.repeat(2000)) }
  if (path === '/files/short.csv') { res.writeHead(200, { 'content-length': 10 }); res.write('abc'); setTimeout(() => res.socket?.destroy(), 20); return }
  if (path === '/files/dies-first.csv') {
    res.writeHead(200, { 'content-length': 1000 }); res.write('x'.repeat(10))
    res.on('close', () => closed.add(path))
    setTimeout(() => res.socket?.destroy(), 100)
    return
  }
  if (path === '/files/late.csv') {
    res.on('close', () => closed.add(path))
    setTimeout(() => { res.writeHead(200, { 'content-length': 3 }); res.end('abc') }, 500)
    return
  }
  if (path === '/files/slow.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-length': 10 * 1024 * 1024 })
    const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 120)), 20)
    res.on('close', () => { clearInterval(timer); releaseSlow() })
    return
  }
  if (path.startsWith('/files/hang')) {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-length': 10 * 1024 * 1024 })
    const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024, 120)), 20)
    res.on('close', () => { clearInterval(timer); closed.add(path) })
    return
  }
  res.writeHead(404)
  res.end()
})

interface Received { url: string, headers: IncomingHttpHeaders, body: Buffer }
const received: Received[] = []
const api = createServer((req, res) => {
  req.on('error', () => {})
  if (req.url!.includes('/slow-413/')) {
    // the head first, the body later, while the upload is still going on
    res.writeHead(413, { 'content-type': 'text/plain' })
    res.write('too ')
    setTimeout(() => res.end('big'), 250)
    return
  }
  if (req.url!.includes('/too-big/')) { res.writeHead(413); return res.end('too big') }
  // an API checking a quota before reading refuses an upload of unknown size
  if (req.headers['content-length'] === undefined) { res.writeHead(411); return res.end('length required') }
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    received.push({ url: req.url!, headers: req.headers, body: Buffer.concat(chunks) })
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'd1' }))
  })
})

let src = ''
let apiBase = ''
before(async () => {
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve))
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  src = `http://127.0.0.1:${(source.address() as any).port}`
  apiBase = `http://127.0.0.1:${(api.address() as any).port}/api`
})
after(() => {
  source.closeAllConnections(); source.close()
  api.closeAllConnections(); api.close()
})

/** the source server plays the file store: its /files/ path is the configured prefix */
const tool = async (name: string, files: FileLoadOptions = {}) => {
  const ts = await load(filesDoc, { baseUrl: apiBase, files: { urlPrefixes: [`${src}/files/`], ...files } })
  return ts.tools.find(t => t.name === name)!
}
const form = (r: Received) => new Response(new Uint8Array(r.body), { headers: { 'content-type': r.headers['content-type'] as string } }).formData()

describe('file inputs, end to end', () => {
  it('streams a file from its URL into a multipart request with an exact Content-Length', async () => {
    received.length = 0
    const res = await (await tool('create_collection')).execute({ file: `${src}/files/report.csv?X-Amz-Signature=abc`, title: 'Lines', schema: [{ key: 'a' }], draft: true })
    assert.ok(!res.isError, res.text)
    const [r] = received
    assert.equal(r.url, '/api/collections')
    assert.equal(Number(r.headers['content-length']), r.body.length)
    assert.equal(r.headers['transfer-encoding'], undefined)
    assert.match(r.headers['content-type'] as string, /^multipart\/form-data; boundary=/)
    const f = await form(r)
    const file = f.get('file') as File
    assert.equal(file.name, 'report.csv')
    assert.equal(file.type, 'text/csv')
    assert.equal(await file.text(), 'a,b\n1,2\n')
    assert.equal(f.get('title'), 'Lines')
    assert.equal(f.get('schema'), '[{"key":"a"}]')
    assert.equal(f.get('draft'), 'true')
    assert.ok(r.body.indexOf('name="title"') < r.body.indexOf('name="file"'))
  })
  it('sends a raw body typed by its source when the operation declares that type', async () => {
    received.length = 0
    const bulk = await tool('bulk_lines')
    assert.ok(!(await bulk.execute({ id: 'd1', file: `${src}/files/report.csv` })).isError)
    assert.ok(!(await bulk.execute({ id: 'd1', file: `${src}/files/lines.ndjson` })).isError)
    assert.deepEqual(received.map(r => [r.url, r.headers['content-type'], r.headers['content-length'], r.body.toString()]), [
      ['/api/collections/d1/_bulk_items', 'text/csv', '8', 'a,b\n1,2\n'],
      ['/api/collections/d1/_bulk_items', 'application/x-ndjson', '8', '{"a":1}\n']
    ])
  })
  it('decodes a percent-encoded file name and counts its bytes', async () => {
    received.length = 0
    const res = await (await tool('create_collection')).execute({ file: `${src}/files/h%C3%A9t%C3%A9.csv` })
    assert.ok(!res.isError, res.text)
    const [r] = received
    assert.equal(Number(r.headers['content-length']), r.body.length)
    const file = (await form(r)).get('file') as File
    assert.equal(file.name, 'hété.csv')
    assert.equal(await file.text(), 'é,1\n')
  })
  it("never sends the caller's credentials to the file URL", async () => {
    received.length = 0
    sourceHeaders.length = 0
    const res = await (await tool('bulk_lines')).execute({ id: 'd1', file: `${src}/files/report.csv` }, { headers: { cookie: 'id_token=secret', authorization: 'Bearer secret' } })
    assert.ok(!res.isError, res.text)
    assert.equal(sourceHeaders[0].cookie, undefined)
    assert.equal(sourceHeaders[0].authorization, undefined)
    assert.equal(received[0].headers.cookie, 'id_token=secret')
  })
  it("reports a file that cannot be fetched without the URL's query string, and sends nothing", async () => {
    received.length = 0
    const res = await (await tool('create_collection')).execute({ file: `${src}/files/missing.csv?X-Amz-Signature=secret` })
    assert.equal(res.isError, true)
    assert.match(res.text, /^File "file" \(http:\/\/127\.0\.0\.1:\d+\/files\/missing\.csv\) could not be fetched: HTTP 404$/)
    assert.doesNotMatch(res.text, /secret/)
    assert.equal(received.length, 0)
  })
  it('refuses a URL outside the file store, and sends nothing', async () => {
    received.length = 0
    sourceHeaders.length = 0
    const res = await (await tool('create_collection')).execute({ file: `${src}/other/report.csv?X-Amz-Signature=secret` })
    assert.equal(res.isError, true)
    assert.match(res.text, /^File "file" \(http:\/\/127\.0\.0\.1:\d+\/other\/report\.csv\) could not be fetched: not a file store URL/)
    assert.doesNotMatch(res.text, /secret/)
    assert.equal(sourceHeaders.length, 0)
    assert.equal(received.length, 0)
  })
  it('offers no tool that needs a file when no prefix is configured', async () => {
    const ts = await load(filesDoc, { baseUrl: apiBase })
    assert.deepEqual(ts.tools.map(t => t.name).sort(), ['download_raw', 'export_lines'])
  })
  it('publishes the size cap and enforces it before any upload', async () => {
    received.length = 0
    const create = await tool('create_collection', { maxSize: 1000 })
    assert.equal(create.inputSchema.properties.file['x-mcp-file'].maxSize, 1000)
    const res = await create.execute({ file: `${src}/files/big.csv` })
    assert.match(res.text, /over the 1000 bytes limit/)
    assert.equal(received.length, 0)
  })
  it('publishes the default cap', async () => {
    assert.equal((await tool('create_collection')).inputSchema.properties.file['x-mcp-file'].maxSize, 104857600)
  })
  it('fails the upload rather than truncate it when the source stops short', async () => {
    received.length = 0
    const res = await (await tool('bulk_lines')).execute({ id: 'd1', file: `${src}/files/short.csv` })
    assert.equal(res.isError, true)
    assert.match(res.text, /^Request failed: .*the source (sent|failed after) 3 of 10 bytes/)
    assert.equal(received.length, 0)
  })
  it('returns an early upstream error and releases the source', async () => {
    const res = await (await tool('bulk_lines')).execute({ id: 'too-big', file: `${src}/files/slow.csv` })
    assert.deepEqual(res, { isError: true, text: 'HTTP 413: too big' })
    await Promise.race([slowClosed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the source connection was not released within 2s')), 2000))])
  })
  it('returns an early upstream error whose body is still arriving, and releases the source', async () => {
    const res = await (await tool('bulk_lines')).execute({ id: 'slow-413', file: `${src}/files/hang-slow413.csv` })
    assert.deepEqual(res, { isError: true, text: 'HTTP 413: too big' })
    await released('/files/hang-slow413.csv')
  })
  it('releases the source when the upstream fetch throws', async () => {
    const ts = await load(filesDoc, { baseUrl: apiBase, files: { urlPrefixes: [`${src}/files/`] }, fetch: async () => { throw new Error('boom') } })
    const res = await ts.tools.find(t => t.name === 'bulk_lines')!.execute({ id: 'd1', file: `${src}/files/hang-fetch.csv` })
    assert.deepEqual(res, { isError: true, text: 'Request failed: boom' })
    await released('/files/hang-fetch.csv')
  })
  it("releases the source when the caller's signal aborts the call", async () => {
    const abort = new AbortController()
    const run = (await tool('bulk_lines')).execute({ id: 'd1', file: `${src}/files/hang-abort.csv` }, { signal: abort.signal })
    setTimeout(() => abort.abort(), 200)
    const res = await run
    assert.equal(res.isError, true)
    await released('/files/hang-abort.csv')
  })
  it('releases the first source when a later file cannot be opened', async () => {
    const part = { type: 'string', format: 'binary', contentMediaType: 'text/csv' }
    const doc = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: { '/two': { post: { operationId: 'two', 'x-agent': { name: 'two' }, requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['a', 'b'], properties: { a: part, b: part } } } } }, responses: { 201: { description: 'ok' } } } } }
    }
    const ts = await load(doc, { baseUrl: apiBase, files: { urlPrefixes: [`${src}/files/`] } })
    const t = ts.tools.find(x => x.name === 'two')
    assert.ok(t, 'a two-file operation is offered')
    const res = await t.execute({ a: `${src}/files/hang-first.csv`, b: `${src}/files/missing.csv` })
    assert.equal(res.isError, true)
    assert.match(res.text, /File "b" .* could not be fetched: HTTP 404/)
    await released('/files/hang-first.csv')
  })
  it('fails, naming the input, when a source fails while a later file is still opening', async () => {
    const part = { type: 'string', format: 'binary', contentMediaType: 'text/csv' }
    const doc = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: { '/two': { post: { operationId: 'two', 'x-agent': { name: 'two' }, requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['a', 'b'], properties: { a: part, b: part } } } } }, responses: { 201: { description: 'ok' } } } } }
    }
    const ts = await load(doc, { baseUrl: apiBase, files: { urlPrefixes: [`${src}/files/`] } })
    // an uncaught exception fails the test itself
    {
      const res = await ts.tools.find(x => x.name === 'two')!.execute({ a: `${src}/files/dies-first.csv?sig=secret`, b: `${src}/files/late.csv` })
      await new Promise(resolve => setTimeout(resolve, 200))
      assert.equal(res.isError, true)
      assert.match(res.text, /File "a" \(http:\/\/127\.0\.0\.1:\d+\/files\/dies-first\.csv\) could not be fetched: the source failed after 10 of 1000 bytes/)
      assert.ok(!res.text.includes('secret'))
      await released('/files/dies-first.csv')
      await released('/files/late.csv')
    }
  })
  it('fails the upload, and releases every source, when a source not yet being read fails', async () => {
    const part = { type: 'string', format: 'binary', contentMediaType: 'text/csv' }
    const doc = {
      openapi: '3.1.0',
      info: { title: 't', version: '1' },
      paths: { '/two': { post: { operationId: 'two', 'x-agent': { name: 'two' }, requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['a', 'b'], properties: { a: part, b: part } } } } }, responses: { 201: { description: 'ok' } } } } }
    }
    const ts = await load(doc, { baseUrl: apiBase, files: { urlPrefixes: [`${src}/files/`] } })
    const res = await ts.tools.find(x => x.name === 'two')!.execute({ a: `${src}/files/hang-streaming.csv`, b: `${src}/files/dies-first.csv` })
    assert.equal(res.isError, true)
    assert.match(res.text, /the source failed after 10 of 1000 bytes/)
    await released('/files/hang-streaming.csv')
    await released('/files/dies-first.csv')
  })
})
