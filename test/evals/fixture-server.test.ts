import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startFixtureServer } from '../../evals/fixture-server.ts'

describe('startFixtureServer', () => {
  it('serves the annotated frozen document and a stable hash', async () => {
    const srv = await startFixtureServer()
    try {
      assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/openapi\.json$/)
      assert.match(srv.hash, /^[0-9a-f]{12}$/)
      const doc: any = await (await fetch(srv.url)).json()
      assert.ok(doc['x-agent'], 'annotations must be merged in')
      assert.equal(doc.servers[0].url, 'https://opendata.koumoul.com/data-fair/api/v1')
      assert.equal(Object.keys(doc.paths).length, 44)
    } finally {
      await srv.close()
    }
  })
})
