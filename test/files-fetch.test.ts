import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createFileFetcher, underPrefix, fileName, displayUrl, type FileLoadOptions } from '../src/files.ts'
import type { FileSource } from '../src/multipart.ts'

let base = ''
const hits: string[] = []
const store = createServer((req, res) => {
  hits.push(req.url!)
  const path = req.url!.split('?')[0]
  if (path === '/bucket/report.csv') { res.writeHead(200, { 'content-type': 'text/csv', 'content-length': 8 }); return res.end('a,b\n1,2\n') }
  if (path === '/bucket/gzipped.csv') { res.writeHead(200, { 'content-type': 'text/csv', 'content-encoding': 'gzip', 'content-length': 4 }); return res.end('abcd') }
  if (path === '/bucket/h%C3%A9t%C3%A9.csv') { res.writeHead(200, { 'content-length': 2 }); return res.end('ok') }
  if (path === '/bucket/chunked.csv') { res.writeHead(200, { 'content-type': 'text/csv' }); res.write('a,b\n'); return res.end('1,2\n') }
  if (path === '/bucket/big.csv') { res.writeHead(200, { 'content-length': 2000 }); return res.end('x'.repeat(2000)) }
  if (path === '/bucket/short.csv') { res.writeHead(200, { 'content-length': 10 }); res.write('abc'); setTimeout(() => res.socket?.destroy(), 20); return }
  if (path === '/bucket/never.csv') return
  if (path === '/bucket/moved.csv') { res.writeHead(302, { location: '/bucket/report.csv' }); return res.end() }
  res.writeHead(404)
  res.end('not found')
})
before(async () => {
  await new Promise<void>(resolve => store.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(store.address() as any).port}`
})
after(() => { store.closeAllConnections(); store.close() })

/** the test server plays the file store: its bucket is the one configured prefix */
const fetcher = (o: FileLoadOptions = {}) => createFileFetcher({ urlPrefixes: [`${base}/bucket`], ...o })!
const text = async (f: FileSource) => {
  const chunks: Buffer[] = []
  for await (const c of f.body) chunks.push(c)
  return Buffer.concat(chunks).toString()
}

describe('createFileFetcher', () => {
  it('is off without a configured prefix', () => {
    assert.equal(createFileFetcher(), undefined)
    assert.equal(createFileFetcher({ urlPrefixes: [] }), undefined)
  })
  it('refuses a prefix that is not an http(s) URL without credentials', () => {
    assert.throws(() => createFileFetcher({ urlPrefixes: ['s3.example/bucket'] }), /files\.urlPrefixes: "s3\.example\/bucket" is not a URL/)
    assert.throws(() => createFileFetcher({ urlPrefixes: ['ftp://s3.example/bucket'] }), /is not an http or https URL/)
    assert.throws(() => createFileFetcher({ urlPrefixes: ['https://key:secret@s3.example/bucket'] }), /carries credentials/)
  })
  it('opens a file under the prefix: name from the path, size and type from the headers, exactly its bytes', async () => {
    const f = await fetcher().open(`${base}/bucket/report.csv?X-Amz-Signature=abc`)
    assert.equal(f.name, 'report.csv')
    assert.equal(f.size, 8)
    assert.equal(f.contentType, 'text/csv')
    assert.equal(await text(f), 'a,b\n1,2\n')
  })
  it('refuses, without any request, a URL that is not under a prefix once normalized', async () => {
    hits.length = 0
    for (const url of [
      `${base}/bucket-evil/report.csv`,
      `${base}/bucket/../other/report.csv`,
      `${base}/bucket/%2e%2e/other/report.csv`,
      `http://localhost:${new URL(base).port}/bucket/report.csv`,
      `http://key:secret@${new URL(base).host}/bucket/report.csv`,
      'file:///etc/passwd',
      'https://example.com/report.csv'
    ]) {
      await assert.rejects(fetcher().open(url), /not a file store URL/, url)
    }
    assert.deepEqual(hits, [])
  })
  it('refuses a redirect: a presigned URL answers directly', async () => {
    await assert.rejects(fetcher().open(`${base}/bucket/moved.csv`), /HTTP 302: redirects are not followed/)
  })
  it('refuses an encoded response, whose bytes are not the file', async () => {
    await assert.rejects(fetcher().open(`${base}/bucket/gzipped.csv`), /the response is encoded \(gzip\)/)
  })
  it('decodes a percent-encoded file name', async () => {
    const f = await fetcher().open(`${base}/bucket/h%C3%A9t%C3%A9.csv`)
    assert.equal(f.name, 'hété.csv')
    f.close()
  })
  it('refuses a source without Content-Length rather than buffering it', async () => {
    await assert.rejects(fetcher().open(`${base}/bucket/chunked.csv`), /no Content-Length/)
  })
  it('refuses a file over the size cap before reading it', async () => {
    await assert.rejects(fetcher({ maxSize: 1000 }).open(`${base}/bucket/big.csv`), /the file is 2000 bytes, over the 1000 bytes limit/)
  })
  it('reports an HTTP error', async () => {
    await assert.rejects(fetcher().open(`${base}/bucket/missing.csv`), /HTTP 404/)
  })
  it('fails the stream when the source stops short of its Content-Length', async () => {
    const f = await fetcher().open(`${base}/bucket/short.csv`)
    await assert.rejects(text(f), /the source (sent|failed after) 3 of 10 bytes/)
  })
  it('times out', async () => {
    await assert.rejects(fetcher({ timeout: 200 }).open(`${base}/bucket/never.csv`), /timed out after 200 ms/)
  })
  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(fetcher().open(`${base}/bucket/never.csv`, controller.signal), /abort/i)
  })
})

describe('underPrefix', () => {
  it('matches at a boundary only', () => {
    const p = ['https://s3.example/bucket']
    assert.equal(underPrefix('https://s3.example/bucket/a/report.csv', p), true)
    assert.equal(underPrefix('https://s3.example/bucket?list-type=2', p), true)
    assert.equal(underPrefix('https://s3.example/bucket', p), true)
    assert.equal(underPrefix('https://s3.example/bucket-evil/report.csv', p), false)
    assert.equal(underPrefix('https://s3.example/bucketreport.csv', p), false)
    assert.equal(underPrefix('https://s3.example.evil.com/bucket/report.csv', ['https://s3.example']), false)
  })
  it('takes a prefix ending with / ? & or = as its own boundary', () => {
    assert.equal(underPrefix('https://s3.example/bucket/agent-files/x.csv', ['https://s3.example/bucket/agent-']), false)
    assert.equal(underPrefix('https://s3.example/bucket/x.csv', ['https://s3.example/bucket/']), true)
    assert.equal(underPrefix('https://s3.example/get?key=agent-files/x.csv', ['https://s3.example/get?key=']), true)
  })
})

describe('fileName and displayUrl', () => {
  it('takes the decoded last path segment, and needs one', () => {
    assert.equal(fileName(new URL('https://s3.test/bucket/agent-files/x/report%20v2.csv?X-Amz-Signature=s')), 'report v2.csv')
    assert.throws(() => fileName(new URL('https://s3.test/bucket/')), /does not end with a file name/)
  })
  it('never shows the query string', () => {
    assert.equal(displayUrl('https://s3.test/b/report.csv?X-Amz-Signature=secret'), 'https://s3.test/b/report.csv')
    assert.equal(displayUrl('not a url'), '(not a URL)')
  })
})
