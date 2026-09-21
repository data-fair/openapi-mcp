import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { inlineRefs, resolveOperations } from '../src/spec.ts'
import { render, type RenderOptions } from '../src/render.ts'

const petstore = inlineRefs(JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8')))
const listPets = resolveOperations(petstore, 'explore').find(o => o.operationId === 'listPets')!
const goldenDir = new URL('./fixtures/render/', import.meta.url)

// UPDATE_GOLDEN writes the file and then fails the test on purpose: a regeneration run must
// never look green, so a careless UPDATE_GOLDEN=1 run can't silently bless a wrong renderer
// output. Review `git diff test/fixtures/render/` and re-run without UPDATE_GOLDEN to confirm.
async function golden (name: string, actual: string) {
  const file = new URL(name + '.md', goldenDir)
  if (process.env.UPDATE_GOLDEN) {
    await mkdir(goldenDir, { recursive: true })
    await writeFile(file, actual)
    assert.fail('golden regenerated: review `git diff test/fixtures/render/` and re-run without UPDATE_GOLDEN')
  }
  assert.equal(actual, await readFile(file, 'utf8'))
}

const body = {
  total: 2,
  results: [
    { id: 'p1', name: 'Rex', tags: ['dog', 'big'], owner: { name: 'Ann', email: 'a@x' }, internalCode: 'X1' },
    { id: 'p2', name: 'Tom | cat', tags: [], owner: { name: 'Bob', email: 'b@x' }, internalCode: 'X2' }
  ],
  next: 'https://pets.example/api/pets?after=2',
  meta: { hints: ['use q for text search'] }
}
const base: RenderOptions = { schema: listPets.responseSchema, response: listPets.agent.response, locale: 'en' }

describe('render', () => {
  it('renders rows as a table with concise projection, hints and excludes', async () => {
    await golden('list-concise', render(body, base))
  })
  it('renders the detailed preset', async () => {
    await golden('list-detailed', render(body, { ...base, responseFormat: 'detailed' }))
  })
  it('renders an explicit fields projection', async () => {
    await golden('list-fields', render(body, { ...base, fields: ['name', 'owner'] }))
  })
  it('renders an empty rows array', () => {
    assert.match(render({ total: 0, results: [] }, base), /_\(no rows\)_/)
  })
  it('renders a single object with nested values and excludes', async () => {
    const pet = petstore.components.schemas.pet
    await golden('object', render(body.results[0], { schema: pet, locale: 'en' }))
  })
  it('renders arrays of scalars and truncates long strings', () => {
    assert.equal(render(['a', 'b'], { locale: 'en' }), '- a\n- b')
    assert.equal(render('x'.repeat(20), { locale: 'en', maxStringLength: 5 }), 'xxxxx…')
  })
  it('renders arrays of objects without a schema as a table', () => {
    const out = render([{ a: 1, b: 'x' }, { a: 2, b: 'y' }], { locale: 'en' })
    assert.equal(out, '| a | b |\n| --- | --- |\n| 1 | x |\n| 2 | y |')
  })
})
