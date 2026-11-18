import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { localize, localizeSchema } from '../src/localize.ts'

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

describe('localizeSchema', () => {
  const schema = {
    type: 'object',
    title: 'Scheduling',
    'x-i18n-title': { fr: 'Planification' },
    properties: {
      hour: { type: 'integer', description: 'Hour', 'x-i18n-description': { fr: 'Heure', en: 'Hour of the day' } }
    },
    items: [{ title: 'Monday', 'x-i18n-title': { fr: 'Lundi' } }],
    default: { 'x-i18n-title': { fr: 'data' } }
  }
  it('replaces each annotated keyword with its translation and drops the annotations', () => {
    assert.deepEqual(localizeSchema(schema, 'fr'), {
      type: 'object',
      title: 'Planification',
      properties: { hour: { type: 'integer', description: 'Heure' } },
      items: [{ title: 'Lundi' }],
      default: { 'x-i18n-title': { fr: 'data' } }
    })
  })
  it('keeps the original text when the locale has no translation', () => {
    const en = localizeSchema(schema, 'en')
    assert.equal(en.title, 'Scheduling')
    assert.equal(en.properties.hour.description, 'Hour of the day')
    assert.equal(en.items[0].title, 'Monday')
    assert.ok(!JSON.stringify({ ...en, default: undefined }).includes('x-i18n-'))
  })
  it('leaves the schema it was given unchanged', () => {
    localizeSchema(schema, 'fr')
    assert.equal(schema.title, 'Scheduling')
    assert.deepEqual(schema['x-i18n-title'], { fr: 'Planification' })
  })
})
