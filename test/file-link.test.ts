import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from '../src/load.ts'
import { linkMimeType, linkName } from '../src/file-link.ts'

const filesDoc = JSON.parse(await readFile(new URL('./fixtures/files.json', import.meta.url), 'utf8'))
const recorder = () => {
  const calls: unknown[] = []
  const fetchFn = (async (input: RequestInfo | URL) => { calls.push(input); return new Response('{}') }) as typeof fetch
  return { calls, fetchFn }
}

describe('response.file', () => {
  it('returns a resource link built from the arguments and fixed values, without any request', async () => {
    const { calls, fetchFn } = recorder()
    const ts = await load(filesDoc, { fetch: fetchFn })
    const res = await ts.tools.find(t => t.name === 'export_lines')!.execute({ id: 'c1 2024', q: 'paris' })
    const uri = 'https://files.example/api/collections/c1%202024/lines?q=paris&format=csv'
    assert.deepEqual(res, {
      text: `File c1-2024-lines.csv (text/csv), not downloaded by this tool: ${uri}`,
      resourceLink: { uri, name: 'c1-2024-lines.csv', mimeType: 'text/csv' }
    })
    assert.equal(calls.length, 0)
  })
  it('gives no type and no extension for application/octet-stream', async () => {
    const ts = await load(filesDoc, { fetch: recorder().fetchFn })
    const res = await ts.tools.find(t => t.name === 'download_raw')!.execute({ id: 'c1' })
    assert.deepEqual(res.resourceLink, { uri: 'https://files.example/api/collections/c1/raw', name: 'c1-raw' })
    assert.ok(!res.text.includes('('))
  })
  it('validates the arguments before building the link', async () => {
    const ts = await load(filesDoc, { fetch: recorder().fetchFn })
    const res = await ts.tools.find(t => t.name === 'export_lines')!.execute({})
    assert.equal(res.isError, true)
    assert.match(res.text, /^Invalid parameters/)
  })
  it('declares no output schema, even with structuredContent', async () => {
    const ts = await load(filesDoc, { fetch: recorder().fetchFn, structuredContent: true })
    assert.equal(ts.tools.find(t => t.name === 'export_lines')!.outputSchema, undefined)
    assert.equal(ts.tools.find(t => t.name === 'export_lines')!.annotations.readOnlyHint, true)
  })
  it('refuses a header parameter, which a link cannot carry', async () => {
    const doc = structuredClone(filesDoc)
    doc.paths['/collections/{id}/lines'].get.parameters.push({ in: 'header', name: 'x-trace', schema: { type: 'string' } })
    await assert.rejects(load(doc, { fetch: recorder().fetchFn }), /export_lines: response\.file returns a link, which cannot carry header parameters \(x-trace\)/)
  })
})

describe('linkMimeType', () => {
  it('is the declared type, or among several the one a format value names', () => {
    assert.equal(linkMimeType(['text/csv; charset=utf-8'], new URL('https://x.test/a')), 'text/csv')
    assert.equal(linkMimeType(['application/json', 'text/csv'], new URL('https://x.test/a?format=csv')), 'text/csv')
    assert.equal(linkMimeType(['application/json', 'text/csv'], new URL('https://x.test/a')), undefined)
    assert.equal(linkMimeType(['application/json', 'text/csv'], new URL('https://x.test/a?format=xlsx')), undefined)
    assert.equal(linkMimeType(['application/octet-stream'], new URL('https://x.test/a')), undefined)
    assert.equal(linkMimeType(['*/*'], new URL('https://x.test/a')), undefined)
  })
})

describe('linkName', () => {
  it('names the file after the last path parameter and what follows it', () => {
    assert.equal(linkName('/collections/{id}/lines', new URL('https://x.test/api/collections/c1/lines'), 'text/csv'), 'c1-lines.csv')
    assert.equal(linkName('/files/{name}', new URL('https://x.test/files/report.csv'), 'text/csv'), 'report.csv')
    assert.equal(linkName('/export', new URL('https://x.test/api/export'), 'application/json'), 'export.json')
    assert.equal(linkName('/collections/{id}/raw', new URL('https://x.test/collections/..%2Fetc/raw'), undefined), 'etc-raw')
  })
})
