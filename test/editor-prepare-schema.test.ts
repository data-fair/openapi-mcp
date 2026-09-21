import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compile } from '@json-layout/core'
import { prepareSchema } from '../src/editor/prepare-schema.ts'

const fetched = JSON.parse(await readFile(new URL('./fixtures/dataset-line-schema.json', import.meta.url), 'utf8'))

describe('prepareSchema', () => {
  it('translates vjsf v2 keywords so compile accepts the result', async () => {
    const prepared = await prepareSchema(fetched)
    assert.equal('x-fromUrl' in prepared.properties.departement, false)
    assert.ok(prepared.properties.departement.layout.getItems, 'x-fromUrl should become layout.getItems')
    assert.doesNotThrow(() => compile(prepared))
  })

  it('normalizes a string layout into a component object', async () => {
    const prepared = await prepareSchema(fetched)
    assert.deepEqual(prepared.properties.note.layout, { comp: 'textarea' })
  })

  it('hides attachment columns, which an agent has no file for', async () => {
    const prepared = await prepareSchema(fetched)
    assert.equal(prepared.properties.piece_jointe.layout.comp, 'none')
  })

  it('hides extension columns, which the API computes', async () => {
    const prepared = await prepareSchema(fetched)
    assert.equal(prepared.properties.population_calculee.layout.comp, 'none')
  })

  it('leaves editable columns alone', async () => {
    const prepared = await prepareSchema(fetched)
    assert.equal(prepared.properties.code_commune.layout?.comp, undefined)
  })

  it('does not mutate its input', async () => {
    await prepareSchema(fetched)
    assert.equal(fetched.properties.departement['x-fromUrl'], 'https://example.com/departements')
    assert.equal(fetched.properties.note.layout, 'textarea')
  })

  it('tolerates a schema with no properties', async () => {
    const prepared = await prepareSchema({ type: 'object' })
    assert.doesNotThrow(() => compile(prepared))
  })
})
