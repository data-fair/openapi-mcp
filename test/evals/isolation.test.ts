import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { neutralCwd, scrubEnv, isolationOptions } from '../../evals/isolation.ts'

describe('neutralCwd', () => {
  it('creates a real directory outside the repo whose name carries no signal', () => {
    const dir = neutralCwd()
    assert.ok(existsSync(dir))
    assert.ok(!dir.includes('openapi-mcp'), 'cwd path must not name the project')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('scrubEnv', () => {
  it('removes every CLAUDE_CODE_ variable and keeps the rest', () => {
    const out = scrubEnv({ PATH: '/usr/bin', CLAUDE_CODE_FOO: 'x', CLAUDE_CODE_BAR: 'y', HOME: '/home/u' })
    assert.deepEqual(out, { PATH: '/usr/bin', HOME: '/home/u' })
  })
  it('does not mutate its argument', () => {
    const env = { CLAUDE_CODE_FOO: 'x' }
    scrubEnv(env)
    assert.equal(env.CLAUDE_CODE_FOO, 'x')
  })
})

describe('isolationOptions', () => {
  it('fixes the four options that make a run isolated', () => {
    const o = isolationOptions('/tmp/x', { CLAUDE_CODE_FOO: 'x', PATH: '/usr/bin' })
    assert.equal(o.cwd, '/tmp/x')
    assert.deepEqual(o.settingSources, [])
    assert.deepEqual(o.tools, [])
    assert.equal(o.strictMcpConfig, true)
    assert.deepEqual(o.env, { PATH: '/usr/bin' })
  })
})
