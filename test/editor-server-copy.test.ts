import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'
import { sameShape } from '../src/editor/server-copy.ts'

describe('sameShape', () => {
  it('accepts the document with fields added or dropped', () => {
    assert.equal(sameShape({ a: 1, b: 2, c: 3 }, { a: 1, b: 2, c: 4, updatedAt: 'x' }), true)
  })
  it('refuses an acknowledgment or an envelope', () => {
    assert.equal(sameShape({ a: 1, b: 2 }, { ok: true }), false)
    assert.equal(sameShape({ a: 1, b: 2 }, { config: { a: 1, b: 2 }, id: 'p', owner: {} }), false)
    assert.equal(sameShape({ a: 1 }, undefined), false)
  })
})

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/portals/{id}/config': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'readConfig', responses: { 200: { description: 'ok' } } },
      put: {
        operationId: 'writeConfig',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { color: { type: 'string' }, derived: { type: 'string' } }
              }
            }
          }
        },
        responses: { 200: { description: 'ok' } },
        'x-agent': { name: 'config', editor: { readOperation: 'readConfig' } }
      }
    }
  }
}

/** A server that derives `derived` from `color`, and answers the PUT per `answer`. */
function server (answer: 'stored' | 'ack' | 'empty' | 'envelope') {
  let stored: any = { color: 'blue', derived: 'BLUE' }
  return (async (input: Request) => {
    if (input.method === 'PUT') {
      const body = JSON.parse(await input.text())
      stored = { ...body, derived: String(body.color).toUpperCase() }
      if (answer === 'ack') return new Response(JSON.stringify({ ok: true }))
      if (answer === 'empty') return new Response(null, { status: 204 })
      if (answer === 'envelope') return new Response(JSON.stringify({ id: 'portal', config: stored }))
    }
    return new Response(JSON.stringify(stored), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
}

async function tools (answer: 'stored' | 'ack' | 'empty' | 'envelope') {
  const { tools } = await load(doc, { fetch: server(answer), baseUrl: 'https://api.test' })
  const by = (verb: string) => tools.find(t => t.name === `config_${verb}`)!
  return { set: by('setFieldValue'), save: by('saveForm'), get: by('getData') }
}

describe('editor save adopts the server copy', () => {
  it('loads the fields the server changed into the form and names them', async () => {
    const { set, save, get } = await tools('stored')
    await set.execute({ id: 'p', path: '/color', value: 'red' })
    const saved = await save.execute({ id: 'p' })
    assert.equal(saved.isError, undefined, saved.text)
    assert.match(saved.text, /the server changed 1 field\(s\) while saving: \/derived; the form now holds the server's copy/)
    assert.match((await get.execute({ id: 'p' })).text, /RED/)
  })

  it('says so on a write saved with save: true', async () => {
    const { set, get } = await tools('stored')
    const result = await set.execute({ id: 'p', path: '/color', value: 'green', save: true })
    assert.match(result.text, /saved/)
    assert.match(result.text, /\/derived/)
    assert.match((await get.execute({ id: 'p' })).text, /GREEN/)
  })

  it('adds nothing when the server stored what was sent', async () => {
    const { set, save } = await tools('stored')
    await set.execute({ id: 'p', path: '/color', value: 'BLUE' })
    const saved = await save.execute({ id: 'p' })
    assert.doesNotMatch(saved.text, /server/)
  })

  it('keeps an envelope out of the form', async () => {
    const { set, save, get } = await tools('envelope')
    await set.execute({ id: 'p', path: '/color', value: 'red' })
    const saved = await save.execute({ id: 'p' })
    assert.match(saved.text, /could not be checked/)
    assert.doesNotMatch((await get.execute({ id: 'p' })).text, /portal/)
  })

  for (const answer of ['ack', 'empty'] as const) {
    it(`points to reloadForm when the answer cannot be compared (${answer})`, async () => {
      const { set, save, get } = await tools(answer)
      await set.execute({ id: 'p', path: '/color', value: 'red' })
      const saved = await save.execute({ id: 'p' })
      assert.equal(saved.isError, undefined, saved.text)
      assert.match(saved.text, /could not be checked: call config_reloadForm/)
      assert.match((await get.execute({ id: 'p' })).text, /BLUE/)
    })
  }

  it('reports nothing on a write that does not save', async () => {
    const { set } = await tools('stored')
    const result = await set.execute({ id: 'p', path: '/color', value: 'red' })
    assert.doesNotMatch(result.text, /server/)
  })
})
