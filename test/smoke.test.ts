import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/index.ts'

describe('package', () => {
  it('exports the public load function', () => {
    assert.equal(typeof load, 'function')
  })
})
