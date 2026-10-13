import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inlineRefs, resolveOperations } from '../src/spec.ts'
import { buildInput, responseFields, isFilePart, FILE_NOTE } from '../src/input.ts'

const petstore = inlineRefs(JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8')))
const ops = resolveOperations(petstore, 'explore')
const listPets = ops.find(o => o.operationId === 'listPets')!
const getPet = ops.find(o => o.operationId === 'getPet')!
const createPet = resolveOperations(petstore, 'edit')[0]
const views = inlineRefs(JSON.parse(await readFile(new URL('./fixtures/views.json', import.meta.url), 'utf8')))
const [updateThing, publishThing] = resolveOperations(views, 'manage')

describe('buildInput', () => {
  it('renames, excludes, applies overrides and drops fixed params', () => {
    const { inputSchema, bindings } = buildInput(listPets, 'en')
    assert.deepEqual(Object.keys(inputSchema.properties).sort(), ['fields', 'filters', 'query', 'response_format', 'size'].sort())
    assert.equal(inputSchema.properties.size.maximum, 100)
    assert.equal(inputSchema.properties.size.default, 10)
    assert.equal(inputSchema.properties.query.description, 'Full text search')
    assert.deepEqual(bindings.find(b => b.toolName === 'query'), { toolName: 'query', kind: 'query', apiName: 'q', style: undefined, explode: undefined })
    assert.equal(inputSchema.type, 'object')
    assert.equal(inputSchema.additionalProperties, false)
  })
  it('generates fields from the rows item schema and binds it to selectParam', () => {
    const { inputSchema, bindings } = buildInput(listPets, 'en')
    assert.deepEqual(inputSchema.properties.fields, {
      type: 'array',
      items: { type: 'string', enum: ['id', 'name', 'tags', 'owner'] },
      description: 'Response fields to return (default: the concise set). Use to fetch exactly what you need.'
    })
    assert.deepEqual(bindings.find(b => b.toolName === 'fields'), { toolName: 'fields', kind: 'fields', apiName: 'select', style: 'form', explode: false })
    assert.ok(!inputSchema.properties.select)
  })
  it('generates response_format when both presets exist', () => {
    const { inputSchema } = buildInput(listPets, 'en')
    assert.deepEqual(inputSchema.properties.response_format, { type: 'string', enum: ['concise', 'detailed'], default: 'concise', description: 'concise: id, name. detailed: every field.' })
    assert.ok(!buildInput(getPet, 'en').inputSchema.properties.response_format)
  })
  it('localizes overridden descriptions and marks required path params', () => {
    const { inputSchema } = buildInput(getPet, 'fr')
    assert.equal(inputSchema.properties.id.description, 'The pet id from list_pets')
    assert.deepEqual(inputSchema.required, ['id'])
  })
  it('merges an object request body at top level', () => {
    const { inputSchema, bindings } = buildInput(createPet, 'en')
    assert.deepEqual(Object.keys(inputSchema.properties).sort(), ['id', 'internalCode', 'name', 'owner', 'tags'])
    assert.deepEqual(bindings.find(b => b.toolName === 'name'), { toolName: 'name', kind: 'bodyProp', apiName: 'name', style: undefined, explode: undefined })
  })
  it('suffixes a body property colliding with a parameter', () => {
    const op = structuredClone(createPet)
    op.params.push({ name: 'name', in: 'query', required: false, schema: { type: 'string' }, agent: {} })
    const { inputSchema, bindings } = buildInput(op, 'en')
    assert.ok(inputSchema.properties.name && inputSchema.properties.name__body)
    assert.equal(bindings.find(b => b.toolName === 'name__body')!.kind, 'bodyProp')
  })
  it('wraps a non-object body as a single body property', () => {
    const op = structuredClone(createPet)
    op.requestBody = { kind: 'json', schema: { type: 'array', items: { type: 'string' } }, required: true }
    const { inputSchema, bindings } = buildInput(op, 'en')
    assert.equal(inputSchema.properties.body.type, 'array')
    assert.deepEqual(inputSchema.required, ['body'])
    assert.equal(bindings.find(b => b.toolName === 'body')!.kind, 'body')
  })
  it('passes an undeclared explode through unchanged on the fields binding', () => {
    const op = structuredClone(listPets)
    const selectParam = op.params.find(p => p.name === 'select')!
    delete selectParam.style
    delete selectParam.explode
    const { bindings } = buildInput(op, 'en')
    assert.deepEqual(bindings.find(b => b.toolName === 'fields'), { toolName: 'fields', kind: 'fields', apiName: 'select', style: 'form', explode: undefined })
  })
  it('drops an otherwise-required param from required via agent.required: false', () => {
    const op = structuredClone(getPet)
    op.params.find(p => p.name === 'petId')!.agent.required = false
    assert.equal(buildInput(op, 'en').inputSchema.required, undefined)
  })
  it('adds an otherwise-optional param to required via agent.required: true', () => {
    const op = structuredClone(listPets)
    op.params.find(p => p.name === 'q')!.agent.required = true
    assert.ok(buildInput(op, 'en').inputSchema.required?.includes('query'))
  })
  it('routes default/maximum/enum onto items for an array-typed param, and keeps them top-level for a scalar', () => {
    const op = structuredClone(listPets)
    op.agent = { ...op.agent, fixed: {}, response: { ...op.agent.response, selectParam: undefined } }
    const selectParam = op.params.find(p => p.name === 'select')!
    selectParam.agent = { ...selectParam.agent, default: ['id', 'name'], maximum: 5, enum: ['id', 'name', 'tags'] }
    const sizeParam = op.params.find(p => p.name === 'size')!
    sizeParam.agent = { ...sizeParam.agent, default: 20, maximum: 50, enum: [10, 20, 50] }
    const { inputSchema } = buildInput(op, 'en')
    assert.equal(inputSchema.properties.select.type, 'array')
    assert.equal(inputSchema.properties.select.default, undefined)
    assert.equal(inputSchema.properties.select.maximum, undefined)
    assert.equal(inputSchema.properties.select.enum, undefined)
    assert.deepEqual(inputSchema.properties.select.items.default, ['id', 'name'])
    assert.equal(inputSchema.properties.select.items.maximum, 5)
    assert.deepEqual(inputSchema.properties.select.items.enum, ['id', 'name', 'tags'])
    assert.equal(inputSchema.properties.size.default, 20)
    assert.equal(inputSchema.properties.size.maximum, 50)
    assert.deepEqual(inputSchema.properties.size.enum, [10, 20, 50])
  })
  it('throws when response.selectParam names a parameter the operation does not have', () => {
    const op = structuredClone(getPet)
    op.agent = { ...op.agent, response: { selectParam: 'bogus' } }
    assert.throws(() => buildInput(op, 'en'), /bogus/)
  })
  it('drops an inherited raw OpenAPI title from the param schema', () => {
    const op = structuredClone(listPets)
    op.params.find(p => p.name === 'q')!.schema.title = 'Recherche textuelle'
    const { inputSchema } = buildInput(op, 'en')
    assert.equal(inputSchema.properties.query.title, undefined)
  })
  it('throws when response.selectParam would yield an empty fields enum (response schema has no properties)', () => {
    const op = structuredClone(listPets)
    op.responseSchema = { type: 'object' }
    assert.throws(() => buildInput(op, 'en'), /declares no properties/)
  })
})

describe('responseFields', () => {
  it('lists the rows item keys or the top-level keys', () => {
    assert.deepEqual(responseFields(listPets.responseSchema, '/results'), ['id', 'name', 'tags', 'owner'])
    assert.deepEqual(responseFields(listPets.responseSchema), ['total', 'results', 'next', 'meta'])
    assert.deepEqual(responseFields(undefined), [])
  })
})

describe('buildInput — bodyFields', () => {
  it('exposes only the allowed body properties in flat mode, keeping their required flags', () => {
    const update = buildInput(updateThing, 'en')
    assert.deepEqual(Object.keys(update.inputSchema.properties), ['id', 'title', 'description'])
    assert.deepEqual(update.inputSchema.required, ['id', 'title'])
    const publish = buildInput(publishThing, 'en')
    assert.deepEqual(Object.keys(publish.inputSchema.properties), ['id', 'publicationSites'])
    assert.deepEqual(publish.inputSchema.required, ['id'])
  })
  it('prunes the compact listing and the validation schema alike, refusing other properties', () => {
    const op = { ...publishThing, agent: { ...publishThing.agent, body: 'compact' as const } }
    const { inputSchema, bodySchema } = buildInput(op, 'en')
    assert.deepEqual(Object.keys(bodySchema!.properties), ['publicationSites'])
    assert.equal(bodySchema!.additionalProperties, false)
    assert.equal(bodySchema!.required, undefined)
    assert.match(inputSchema.properties.body.description, /publicationSites/)
    assert.doesNotMatch(inputSchema.properties.body.description, /title/)
  })
  it('fails on a property the body does not declare', () => {
    const op = { ...publishThing, agent: { ...publishThing.agent, bodyFields: ['publicationSites', 'nope'] } }
    assert.throws(() => buildInput(op, 'en'), /t_publish_thing: bodyFields names properties the request body does not declare: nope/)
  })
  it('fails on a body that is not an object with properties', () => {
    const op = { ...publishThing, requestBody: { kind: 'json' as const, schema: { type: 'array', items: { type: 'string' } }, required: true } }
    assert.throws(() => buildInput(op, 'en'), /t_publish_thing: bodyFields needs an object request body with properties/)
  })
})

const filesDoc = inlineRefs(JSON.parse(await readFile(new URL('./fixtures/files.json', import.meta.url), 'utf8')))
const fileOps = resolveOperations(filesDoc, 'edit')
const createDataset = fileOps.find(o => o.operationId === 'createDataset')!
const bulkLines = fileOps.find(o => o.operationId === 'bulkLines')!

/** file inputs on, as when files.urlPrefixes is configured */
const on = { files: { maxSize: 1000 } }

describe('buildInput — files', () => {
  it('turns binary multipart parts into file URL inputs and keeps the other parts flat', () => {
    const { inputSchema, bindings, unavailable } = buildInput(createDataset, 'en', on)
    assert.equal(unavailable, undefined)
    assert.deepEqual(inputSchema.properties.file, {
      type: 'string',
      format: 'uri',
      description: `The data file.\n\n${FILE_NOTE}`,
      'x-mcp-file': { accept: ['text/csv', 'application/vnd.ms-excel'], maxSize: 1000 }
    })
    assert.deepEqual(inputSchema.properties.attachments['x-mcp-file'], { accept: ['application/zip'], maxSize: 1000 })
    assert.deepEqual(inputSchema.properties.title, { type: 'string' })
    assert.deepEqual(inputSchema.properties.draft, { type: 'boolean' })
    assert.ok(!inputSchema.properties.previews, 'a list of files is not offered')
    assert.deepEqual(inputSchema.required, ['file'])
    assert.deepEqual(bindings.filter(b => b.kind === 'file'), [
      { toolName: 'file', kind: 'file', apiName: 'file', accept: ['text/csv', 'application/vnd.ms-excel'] },
      { toolName: 'attachments', kind: 'file', apiName: 'attachments', accept: ['application/zip'] }
    ])
    assert.equal(bindings.find(b => b.toolName === 'schema')!.kind, 'bodyProp')
  })
  it('leaves accept out when a part declares no specific type', () => {
    const op = structuredClone(createDataset)
    op.requestBody!.encoding = { file: ['application/octet-stream'] }
    const { inputSchema } = buildInput(op, 'en', on)
    assert.deepEqual(inputSchema.properties.file['x-mcp-file'], { maxSize: 1000 })
  })
  it('turns a raw body into one file input named file', () => {
    const { inputSchema, bindings } = buildInput(bulkLines, 'en', on)
    assert.deepEqual(inputSchema.properties.file['x-mcp-file'], { accept: ['text/csv', 'application/x-ndjson'], maxSize: 1000 })
    assert.equal(inputSchema.properties.file.description, FILE_NOTE)
    assert.deepEqual(inputSchema.required, ['id', 'file'])
    assert.deepEqual(bindings.at(-1), { toolName: 'file', kind: 'file', apiName: 'body', accept: ['text/csv', 'application/x-ndjson'] })
  })
  it('suffixes a raw file input colliding with a parameter', () => {
    const op = structuredClone(bulkLines)
    op.params.push({ name: 'file', in: 'query', required: false, schema: { type: 'string' }, agent: {} })
    const { inputSchema, bindings } = buildInput(op, 'en', on)
    assert.ok(inputSchema.properties.file && inputSchema.properties.file__body)
    assert.equal(bindings.find(b => b.toolName === 'file__body')!.kind, 'file')
  })
  it('does not offer a tool that needs a list of files', () => {
    const op = structuredClone(createDataset)
    op.requestBody!.schema.required = ['file', 'previews']
    assert.match(buildInput(op, 'en', on).unavailable!, /create_dataset: multipart part "previews" is a list of files, which a tool cannot send/)
  })
  it('with file inputs off, drops optional file parts and does not offer a tool that needs a file', () => {
    const optional = structuredClone(createDataset)
    optional.requestBody!.schema.required = []
    const off = buildInput(optional, 'en')
    assert.equal(off.unavailable, undefined)
    assert.deepEqual(Object.keys(off.inputSchema.properties), ['title', 'schema', 'draft'])
    assert.ok(!off.bindings.some(b => b.kind === 'file'))
    assert.match(buildInput(createDataset, 'en').unavailable!, /create_dataset: needs a file \("file"\), and file inputs are off/)
    assert.match(buildInput(bulkLines, 'en').unavailable!, /bulk_lines: needs a file \("file"\), and file inputs are off/)
  })
  it('recognises OAS 3.0 binary and OAS 3.1 contentMediaType parts, not inline encoded ones', () => {
    assert.equal(isFilePart({ type: 'string', format: 'binary' }), true)
    assert.equal(isFilePart({ type: 'string', contentMediaType: 'image/png' }), true)
    assert.equal(isFilePart({ type: 'string', contentMediaType: 'image/png', contentEncoding: 'base64' }), false)
    assert.equal(isFilePart({ type: 'string', format: 'byte' }), false)
    assert.equal(isFilePart(undefined), false)
  })
  it('leaves JSON bodies exactly as they were', () => {
    const { inputSchema } = buildInput(createPet, 'en', on)
    assert.ok(!JSON.stringify(inputSchema).includes('x-mcp-file'))
  })
})
