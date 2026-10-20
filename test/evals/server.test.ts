import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { serverSpec, discoverTools } from '../../evals/server.ts'
import { startFixtureServer } from '../../evals/fixture-server.ts'

describe('serverSpec', () => {
  it('runs this repository\'s binary over the given document', () => {
    const s = serverSpec('http://127.0.0.1:1234/openapi.json', 'abc123def456')
    assert.match(s.config.args[0], /src\/bin\/server\.ts$/)
    assert.deepEqual(s.config.env, { OPENAPI_URL: 'http://127.0.0.1:1234/openapi.json' })
    assert.deepEqual(s.provenance, { fixtureHash: 'abc123def456' })
  })
})

describe('discoverTools', () => {
  it('lists the fixture\'s six tools, prefixes them, and sizes what every run sends', async () => {
    const srv = await startFixtureServer()
    try {
      const d = await discoverTools(serverSpec(srv.url, srv.hash))
      assert.deepEqual(d.toolNames.sort(), ['aggregate_data', 'calculate_metric', 'describe_dataset', 'get_field_values', 'list_datasets', 'search_data'])
      assert.deepEqual(d.allowedTools.sort(), d.toolNames.map(n => `mcp__api__${n}`).sort())
      assert.ok(d.definitionBytes > 5000 && d.definitionBytes < 30000, `definitionBytes was ${d.definitionBytes}`)
      assert.ok(d.instructionsBytes > 0, `instructionsBytes was ${d.instructionsBytes}`)
    } finally {
      await srv.close()
    }
  })
})
