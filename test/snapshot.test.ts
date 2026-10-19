import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from '../src/load.ts'
import { toolSetSnapshot } from '../src/snapshot.ts'
import { digestOf } from '../src/skills.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))

describe('toolSetSnapshot', () => {
  it('is a stable, JSON-serializable view of the agent-facing surface', async () => {
    const a = toolSetSnapshot(await load(petstore))
    const b = toolSetSnapshot(await load(petstore))
    assert.deepEqual(a, b)
    assert.deepEqual(Object.keys(a), ['tools', 'skills'])
    assert.deepEqual(Object.keys(a.tools[0]), ['name', 'description', 'inputSchema', 'annotations'])
    assert.deepEqual(a.skills, [
      { id: 'workflow', name: 'workflow', description: 'Start with list_pets, then get_pet.', digest: digestOf('Start with list_pets, then get_pet.') },
      { id: 'editing', name: 'editing', description: 'Use create_pet only when asked.', digest: digestOf('Use create_pet only when asked.') }
    ])
    assert.equal(typeof JSON.stringify(a), 'string')
    assert.equal((a.tools[0] as any).execute, undefined)
  })

  it('never carries undefined, so a golden file round-trips', async () => {
    const doc = structuredClone(petstore)
    doc.paths['/pets'].get.parameters.push({ in: 'query', name: 'flag', schema: { type: 'string', enum: undefined } })
    const snapshot = toolSetSnapshot(await load(doc))
    assert.deepEqual(snapshot, JSON.parse(JSON.stringify(snapshot)))
  })

  it('carries each tool\'s effective security', async () => {
    const entrySecurity = [{ apiKey: [] }, { oauth2: ['items:admin'] }]
    const snapshot = toolSetSnapshot(await load({
      openapi: '3.1.0',
      info: { title: 'Items', version: '1' },
      servers: [{ url: 'https://items.test/api' }],
      security: [{ apiKey: [] }],
      paths: {
        '/items/{id}': {
          patch: {
            operationId: 'patchItem',
            parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }],
            security: [{ apiKey: [] }, { oauth2: ['items:write'] }, { oauth2: ['items:admin'] }],
            'x-agent': [{ name: 'update_item' }, { name: 'publish_item', security: entrySecurity }],
            responses: { 200: { description: 'ok' } }
          }
        },
        '/items': { get: { operationId: 'listItems', 'x-agent': {}, responses: { 200: { description: 'ok' } } } }
      }
    }))
    const security = Object.fromEntries(snapshot.tools.map(t => [t.name, t.security]))
    assert.deepEqual(security.publish_item, entrySecurity)
    assert.deepEqual(security.update_item, [{ apiKey: [] }, { oauth2: ['items:write'] }, { oauth2: ['items:admin'] }])
    assert.deepEqual(security.list_items, [{ apiKey: [] }])
  })
})
