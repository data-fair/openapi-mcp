import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bridgeTool, formToolTitle, neutralText, FORM_VERB_LABELS, isReadOnlyFormTool, toToolResult, type EditorForm } from '../src/editor/bridge.ts'

describe('toToolResult', () => {
  it('joins text content', () => {
    assert.deepEqual(toToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), { text: 'a\nb', isError: undefined })
  })

  it('carries isError through', () => {
    assert.deepEqual(toToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true }), { text: 'boom', isError: true })
  })

  it('survives a result with no content', () => {
    assert.deepEqual(toToolResult({}), { text: '', isError: undefined })
  })
})

describe('bridgeTool', () => {
  const formTool = {
    name: 'form_setFieldValue',
    description: 'Set one field',
    inputSchema: { type: 'object', properties: { pointer: { type: 'string' } }, required: ['pointer'] },
    execute: async (args: any) => ({ content: [{ type: 'text', text: `got ${JSON.stringify(args)}` }] })
  }
  const form = (name: string, pathParams: any[], extra: Partial<EditorForm> = {}): EditorForm => ({
    name, title: name.toUpperCase(), pathParams, resolve: async () => formTool, ...extra
  })
  const line = form('item', [
    { name: 'id', schema: { type: 'string', title: 'Collection' }, required: true, description: 'the collection' },
    { name: 'lineId', schema: { type: 'string' }, required: true }
  ])
  const page = form('page', [{ name: 'id', schema: { type: 'string' }, required: true, description: 'the page' }])

  it('adds form and the path parameters to the input schema, required where every form needs them', () => {
    const tool = bridgeTool(formTool, [line, page])
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['form', 'id', 'lineId', 'pointer'])
    assert.deepEqual(tool.inputSchema.required, ['form', 'id', 'pointer'])
    assert.deepEqual(tool.inputSchema.properties.form.enum, ['item', 'page'])
    assert.match(tool.inputSchema.properties.form.description, /"item": ITEM; "page": PAGE/)
    assert.equal(tool.inputSchema.properties.id.description, 'for "item": the collection; for "page": the page.')
    assert.match(tool.inputSchema.properties.lineId.description, /Only for form "item"/)
  })

  it('takes a parameter\'s x-agent description first', () => {
    const over = form('o', [{ name: 'id', schema: { type: 'string' }, required: true, description: 'raw', agent: { description: { en: 'Id of the portal.' } } }])
    assert.equal(bridgeTool(formTool, [over], 'en').inputSchema.properties.id.description, 'Id of the portal.')
  })

  it('joins per-form descriptions without doubled periods', () => {
    const a = form('a', [{ name: 'id', schema: { type: 'string' }, required: true, description: 'Id of the portal.' }])
    const b = form('b', [{ name: 'id', schema: { type: 'string' }, required: true, description: 'Id of the page.' }])
    assert.equal(bridgeTool(formTool, [a, b]).inputSchema.properties.id.description, 'for "a": Id of the portal; for "b": Id of the page.')
  })

  it('makes differing schemas of one name an anyOf', () => {
    const num = form('n', [{ name: 'id', schema: { type: 'integer' }, required: true }])
    const tool = bridgeTool(formTool, [page, num])
    assert.deepEqual(tool.inputSchema.properties.id.anyOf, [{ type: 'string' }, { type: 'integer' }])
  })

  it('passes only the form tool arguments to the session tool of the form named', async () => {
    const seen: any[] = []
    const tool = bridgeTool(formTool, [line, form('page', page.pathParams, { resolve: async (name, values) => { seen.push([name, values]); return formTool } })])
    const result = await tool.execute({ form: 'page', id: 'home', pointer: '/nom' })
    assert.equal(result.text, 'got {"pointer":"/nom"}')
    assert.deepEqual(seen, [['form_setFieldValue', { id: 'home' }]])
  })

  it('refuses an unknown form, a parameter of another form and a missing one', async () => {
    let called = false
    const tool = bridgeTool(formTool, [line, form('page', page.pathParams, { resolve: async () => { called = true; return formTool } })])
    assert.match((await tool.execute({ form: 'nope', id: 'x', pointer: '/a' })).text, /must name one of the forms/)
    assert.match((await tool.execute({ form: 'page', id: 'x', lineId: 'y', pointer: '/a' })).text, /takes no parameter "lineId"/)
    const missing = await tool.execute({ form: 'item', id: 'x', pointer: '/a' })
    assert.equal(missing.isError, true)
    assert.match(missing.text, /lineId/)
    assert.equal(called, false)
  })

  it('turns a resolver failure into an error result rather than a throw', async () => {
    const tool = bridgeTool(formTool, [form('item', line.pathParams, { resolve: async () => { throw new Error('schema fetch failed: 404') } })])
    const result = await tool.execute({ form: 'item', id: 'cities', lineId: 'abc', pointer: '/nom' })
    assert.equal(result.isError, true)
    assert.match(result.text, /schema fetch failed: 404/)
  })

  it('narrows form to the forms a token is granted, and is dropped when none is', () => {
    const portal = form('portal', [], { security: [{ oauth2: ['portals:config'] }] })
    const draft = form('page', page.pathParams, { security: [{ oauth2: ['pages:edit'] }] })
    const tool = bridgeTool(formTool, [portal, draft])
    assert.deepEqual(tool.security, [{ oauth2: ['portals:config'] }, { oauth2: ['pages:edit'] }])
    const narrowed = tool.forScopes!(['pages:edit'])!
    assert.deepEqual(narrowed.inputSchema.properties.form.enum, ['page'])
    assert.equal(tool.forScopes!(['portals:config', 'pages:edit']), tool)
    assert.equal(tool.forScopes!([]), undefined)
  })
})

describe('neutralText', () => {
  it('takes the bootstrap title out of the package sentences', () => {
    assert.equal(neutralText('Describe the "TTTT" form: x. Get the current "TTTT" data. Write several "TTTT" fields. A field of "TTTT".', 'TTTT'),
      'Describe the form: x. Get the form\'s current data. Write several fields of the form. A field of the form.')
    assert.equal(neutralText('# JSON TTTT Form-Filling Guide', 'TTTT'), '# JSON Form-Filling Guide')
  })
})

describe('isReadOnlyFormTool', () => {
  it('marks the reads read-only and every write, save or reload not', () => {
    for (const verb of ['describeState', 'getData', 'getFieldSuggestions', 'openSection']) {
      assert.equal(isReadOnlyFormTool(`form_${verb}`), true, verb)
      assert.equal(isReadOnlyFormTool(verb), true, verb)
    }
    for (const verb of ['setData', 'setFieldValue', 'editArray', 'saveForm', 'reloadForm']) {
      assert.equal(isReadOnlyFormTool(`form_${verb}`), false, verb)
    }
  })

  const unused = (name: string, extra: Partial<EditorForm> = {}): EditorForm => ({ name, title: 'Page', pathParams: [], resolve: async () => { throw new Error('unused') }, ...extra })
  const tool = (name: string, forms: EditorForm[], locale?: string) => bridgeTool({ name, description: '', execute: async () => ({}) }, forms, locale)

  it('gives the bridged tool its annotation', () => {
    assert.equal(tool('form_getData', [unused('a')]).annotations.readOnlyHint, true)
    assert.equal(tool('form_setData', [unused('a')]).annotations.readOnlyHint, false)
  })

  it('titles a tool of one form with its title, of several with the group label, in the locale', () => {
    assert.equal(tool('form_saveForm', [unused('a')], 'fr').annotations.title, 'Page — enregistrer')
    assert.equal(tool('form_saveForm', [unused('a')], 'en').annotations.title, 'Page — save')
    assert.equal(tool('form_saveForm', [unused('a'), unused('b')], 'fr').annotations.title, 'Formulaire — enregistrer')
    assert.equal(tool('form_editArray', [unused('a'), unused('b')]).annotations.title, 'Form — edit a list')
    for (const verb of Object.keys(FORM_VERB_LABELS)) assert.ok(formToolTitle(`x_${verb}`, 'T', 'fr')?.startsWith('T — '), verb)
    assert.equal(formToolTitle('x_unknown', 'T'), undefined)
  })

  it('is open-world when one form is, closed when every form says so', () => {
    assert.equal(tool('form_getData', [unused('a', { openWorldHint: false }), unused('b', { openWorldHint: false })]).annotations.openWorldHint, false)
    assert.equal(tool('form_getData', [unused('a', { openWorldHint: false }), unused('b', { openWorldHint: true })]).annotations.openWorldHint, true)
    assert.equal(tool('form_getData', [unused('a', { openWorldHint: false }), unused('b')]).annotations.openWorldHint, undefined)
  })
})
