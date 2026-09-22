import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { armA, armB, armC, discoverTools } from '../../evals/arms.ts'
import { startFixtureServer } from '../../evals/fixture-server.ts'

describe('armA', () => {
  it('points at the sibling checkout with stdio transport and records provenance', () => {
    const a = armA('https://opendata.koumoul.com')
    assert.equal(a.name, 'A')
    assert.equal(a.config.command, 'node')
    assert.match(a.config.args[0], /data-fair\/mcp\/index\.ts$/)
    assert.equal(a.config.env.TRANSPORT, 'stdio')
    assert.equal(a.config.env.PORTAL_URL, 'https://opendata.koumoul.com')
    assert.match(a.config.env.NODE_CONFIG_DIR, /data-fair\/mcp\/config$/)
    assert.ok(a.provenance.version, 'records the checkout version')
    assert.ok(a.provenance.commit, 'records the checkout commit')
  })
  it('fails loudly naming the path when the checkout is missing', () => {
    assert.throws(() => armA('https://x.example', '/nope/missing'),
      /arm A: data-fair\/mcp checkout not found at \/nope\/missing/)
  })
})

describe('armB', () => {
  it('runs this repo\'s binary against the given spec URL on the explore profile', () => {
    const b = armB('http://127.0.0.1:1234/openapi.json', 'abc123def456')
    assert.equal(b.name, 'B')
    assert.match(b.config.args[0], /src\/bin\/server\.ts$/)
    assert.equal(b.config.env.PROFILES, 'explore')
    assert.equal(b.config.env.OPENAPI_URL, 'http://127.0.0.1:1234/openapi.json')
    assert.equal(b.provenance.fixtureHash, 'abc123def456')
    assert.equal(b.provenance.profile, 'explore')
  })
})

describe('armC', () => {
  it('runs the binary over an index with the explore profile', () => {
    const c = armC('http://127.0.0.1:1/index.json', 'abc123')
    assert.equal(c.name, 'C')
    assert.equal(c.serverName, 'datafair')
    assert.deepEqual(c.config.env, { INDEX_URL: 'http://127.0.0.1:1/index.json', PROFILES: 'explore', REFRESH_INTERVAL: '0' })
    assert.deepEqual(c.provenance, { fixtureHash: 'abc123', profiles: 'explore', composed: 'true' })
  })
})

describe('discoverTools', () => {
  it('lists arm B\'s six explore tools, prefixes them, and sizes the definitions', async () => {
    const srv = await startFixtureServer()
    try {
      const d = await discoverTools(armB(srv.url, srv.hash))
      assert.deepEqual(d.toolNames.sort(), ['aggregate_data', 'calculate_metric', 'describe_dataset', 'get_field_values', 'list_datasets', 'search_data'])
      assert.ok(d.allowedTools.every(n => n.startsWith('mcp__datafair__')))
      assert.equal(d.allowedTools.length, 6)
      assert.ok(d.definitionBytes > 5000 && d.definitionBytes < 30000, `definitionBytes was ${d.definitionBytes}`)
      // instructionsBytes: the server's `instructions` block, sent through the protocol on
      // every run just like the tool definitions — omitted from definitionBytes on
      // purpose, so it must be measured and reported separately (F5).
      assert.ok(d.instructionsBytes > 0, `instructionsBytes was ${d.instructionsBytes}`)
    } finally {
      await srv.close()
    }
  })

  it('lists the same six tools through arm C, composed over the fixture index', async () => {
    const srv = await startFixtureServer()
    try {
      const d = await discoverTools(armC(srv.indexUrl, srv.hash))
      assert.deepEqual(d.toolNames.sort(), ['aggregate_data', 'calculate_metric', 'describe_dataset', 'get_field_values', 'list_datasets', 'search_data'])
      assert.equal(d.allowedTools.length, 6)
    } finally {
      await srv.close()
    }
  })

  it('connects to arm A for real and lists its seven tools, hitting no network', async () => {
    const d = await discoverTools(armA('https://opendata.koumoul.com'))
    assert.deepEqual(d.toolNames.sort(), ['aggregate_data', 'calculate_metric', 'describe_dataset', 'geocode_address', 'get_field_values', 'list_datasets', 'search_data'])
    assert.ok(d.allowedTools.every(n => n.startsWith('mcp__datafair__')))
    assert.equal(d.allowedTools.length, 7)
    assert.ok(d.definitionBytes > 5000 && d.definitionBytes < 30000, `definitionBytes was ${d.definitionBytes}`)
    assert.ok(d.instructionsBytes > 0, `instructionsBytes was ${d.instructionsBytes}`)
  })
})
