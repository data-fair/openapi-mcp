import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateIndex } from '../src/index-contract.ts'

describe('validateIndex', () => {
  it('accepts a minimal index and one with profiles and skills', () => {
    assert.doesNotThrow(() => validateIndex({ version: 1, services: [{ id: 'data-fair', openapi: 'https://h/api-docs.json' }] }))
    assert.doesNotThrow(() => validateIndex({
      version: 1,
      services: [{ id: 'data-fair', openapi: 'https://h/api-docs.json' }],
      profiles: { full: { title: 'Full', includes: ['explore', 'edit'] } },
      skills: [{ name: 'publishing-workflow', description: 'd', profiles: ['edit'], tools: ['a'] }]
    }))
  })
  it('refuses an unknown version, a bad id, a duplicate id and an unknown key', () => {
    assert.throws(() => validateIndex({ version: 2, services: [] }), /index invalid: \/version/)
    assert.throws(() => validateIndex({ version: 1, services: [{ id: 'Data Fair', openapi: 'https://h' }] }), /\/services\/0\/id/)
    assert.throws(() => validateIndex({ version: 1, services: [{ id: 'a', openapi: 'https://h' }, { id: 'a', openapi: 'https://h2' }] }), /duplicate service id "a"/)
    assert.throws(() => validateIndex({ version: 1, services: [], indexes: [] }), /indexes/)
  })
})
