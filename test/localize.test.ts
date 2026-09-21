import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { localize } from '../src/localize.ts'

describe('localize', () => {
  it('returns plain strings unchanged', () => {
    assert.equal(localize('hello', 'fr'), 'hello')
  })
  it('picks the requested locale', () => {
    assert.equal(localize({ fr: 'bonjour', en: 'hello' }, 'fr'), 'bonjour')
  })
  it('falls back to en, then to the first entry', () => {
    assert.equal(localize({ fr: 'bonjour', en: 'hello' }, 'de'), 'hello')
    assert.equal(localize({ fr: 'bonjour' }, 'de'), 'bonjour')
  })
  it('returns undefined for undefined', () => {
    assert.equal(localize(undefined, 'fr'), undefined)
  })
})
