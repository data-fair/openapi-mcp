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

describe('index skills: description, body and href', () => {
  const index = (skills: unknown[]) => ({ version: 1, services: [{ id: 's', openapi: 'https://s.test/openapi.json' }], skills })
  it('accepts href or body', () => {
    assert.doesNotThrow(() => validateIndex(index([{ name: 'a', description: 'd', href: 'skills/a.md' }, { name: 'b', description: 'd', body: 'b' }])))
  })
  it('refuses a long description and href with body', () => {
    assert.throws(() => validateIndex(index([{ name: 'a', description: 'x'.repeat(1025) }])))
    assert.throws(() => validateIndex(index([{ name: 'a', description: 'd', href: 'a.md', body: 'b' }])))
  })
})
