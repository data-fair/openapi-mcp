import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateVocabulary } from '../src/vocabulary/validate.ts'

const doc = (patch: Record<string, unknown>) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/things': {
      get: {
        operationId: 'listThings',
        parameters: [{ in: 'query', name: 'size', schema: { type: 'integer' } }],
        responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } } }
      }
    }
  },
  ...patch
})

const editorDoc = (editor: unknown) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: { '/things/{id}': { put: { operationId: 'updateThing', 'x-agent': { name: 'thing', editor } } } }
})

describe('validateVocabulary', () => {
  it('accepts a document without x-agent', () => {
    assert.doesNotThrow(() => validateVocabulary(doc({})))
  })
  it('accepts valid root, tag, operation, parameter and property annotations', () => {
    const d: any = doc({
      'x-agent': { namePrefix: 'df_', profiles: { explore: { title: { fr: 'Explorer', en: 'Explore' } } }, skills: [{ name: 'workflow', description: 'Start with list_things.' }] },
      tags: [{ name: 'Things', 'x-agent': { profiles: ['explore'], skill: 'Things are…' } }]
    })
    d.paths['/things'].get['x-agent'] = { profiles: true, name: 'list_things', params: { size: { maximum: 50 } }, response: { rows: '/results', concise: ['id'] } }
    d.paths['/things'].get.parameters[0]['x-agent'] = { default: 10 }
    d.paths['/things'].get.responses[200].content['application/json'].schema.properties.id['x-agent'] = { hint: 'opaque id' }
    assert.doesNotThrow(() => validateVocabulary(d))
  })
  it('rejects a multi-segment rows pointer and accepts a single-segment one', () => {
    const withRows = (rows: string) => {
      const d: any = doc({})
      d.paths['/things'].get['x-agent'] = { profiles: true, response: { rows } }
      return d
    }
    assert.throws(() => validateVocabulary(withRows('/data/results')), /x-agent invalid at \/paths\/~1things\/get: .*rows/)
    assert.doesNotThrow(() => validateVocabulary(withRows('/results')))
  })
  it('rejects unknown fields and names the path', () => {
    const d: any = doc({})
    d.paths['/things'].get['x-agent'] = { profiles: true, template: '{{id}}' }
    assert.throws(() => validateVocabulary(d), /x-agent invalid at \/paths\/~1things\/get: .*template/)
  })
  it('rejects a wrong type at root', () => {
    assert.throws(() => validateVocabulary(doc({ 'x-agent': { namePrefix: 3 } })), /x-agent invalid at \/: .*namePrefix/)
  })
  it('accepts includes on a root profile', () => {
    assert.doesNotThrow(() => validateVocabulary(doc({ 'x-agent': { profiles: { a: {}, b: { includes: ['a'] } } } })))
  })
  it('rejects a skill name outside the Agent Skills format', () => {
    assert.throws(() => validateVocabulary(doc({ 'x-agent': { skills: [{ name: 'Workflow', description: 'd' }] } })), /x-agent invalid at \/: \/skills\/0\/name must match pattern/)
    assert.doesNotThrow(() => validateVocabulary(doc({ 'x-agent': { skills: [{ name: 'publishing-workflow', description: 'd' }] } })))
  })
})

describe('editor annotation', () => {
  it('accepts the full object form', () => {
    const d = editorDoc({ schemaOperation: 'readSchema', schemaParams: { mimeType: 'application/schema+json' }, readOperation: 'readLine' })
    assert.doesNotThrow(() => validateVocabulary(d))
  })

  it('accepts the true shorthand, which means the declared body schema', () => {
    assert.doesNotThrow(() => validateVocabulary(editorDoc(true)))
  })

  it('accepts an object with no schemaOperation', () => {
    assert.doesNotThrow(() => validateVocabulary(editorDoc({ readOperation: 'readLine' })))
  })

  it('rejects an unknown key', () => {
    assert.throws(() => validateVocabulary(editorDoc({ schemaOperation: 'readSchema', schemaOperaton: 'typo' })), /editor/)
  })
})

const viewsDoc = (views: unknown) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: { '/things/{id}': { patch: { operationId: 'patchThing', 'x-agent': views } } }
})

describe('operation views', () => {
  it('accepts an array of named views with body allow-lists', () => {
    assert.doesNotThrow(() => validateVocabulary(viewsDoc([
      { name: 'update_thing', profiles: ['write'], bodyFields: ['title'] },
      { name: 'publish_thing', profiles: ['manage'], bodyFields: ['publicationSites'] }
    ])))
  })
  it('requires a name on every view, naming the view', () => {
    assert.throws(() => validateVocabulary(viewsDoc([{ name: 'update_thing' }, { profiles: ['manage'] }])), /patch\/1: every view of an operation needs a name/)
  })
  it('refuses two views with the same name', () => {
    assert.throws(() => validateVocabulary(viewsDoc([{ name: 'thing' }, { name: 'thing' }])), /patch\/1: duplicate view name "thing"/)
  })
  it('refuses an empty array', () => {
    assert.throws(() => validateVocabulary(viewsDoc([])), /an array of views needs at least one view/)
  })
  it('validates each view against the operation vocabulary, naming its index', () => {
    assert.throws(() => validateVocabulary(viewsDoc([{ name: 'a' }, { name: 'b', bogus: 1 }])), /patch\/1: .*bogus/)
  })
  it('refuses an empty bodyFields', () => {
    assert.throws(() => validateVocabulary(viewsDoc({ name: 'a', bodyFields: [] })), /x-agent invalid/)
  })
})
