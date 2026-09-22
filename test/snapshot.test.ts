import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from '../src/load.ts'
import { toolSetSnapshot } from '../src/snapshot.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))

describe('toolSetSnapshot', () => {
  it('is a stable, JSON-serializable view of the agent-facing surface', async () => {
    const a = toolSetSnapshot(await load(petstore))
    const b = toolSetSnapshot(await load(petstore))
    assert.deepEqual(a, b)
    assert.deepEqual(Object.keys(a), ['profiles', 'tools', 'skills'])
    assert.deepEqual(Object.keys(a.tools[0]), ['name', 'description', 'inputSchema', 'annotations'])
    assert.deepEqual(a.skills, [{ id: 'workflow', name: 'workflow', description: 'Start with list_pets, then get_pet.' }])
    assert.equal(typeof JSON.stringify(a), 'string')
    assert.equal((a.tools[0] as any).execute, undefined)
  })
})
