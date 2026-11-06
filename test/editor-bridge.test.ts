import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bridgeTool, formToolTitle, FORM_VERB_LABELS, isReadOnlyFormTool, toToolResult } from '../src/editor/bridge.ts'

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
    name: 'item_setFieldValue',
    description: 'Set one field',
    inputSchema: { type: 'object', properties: { pointer: { type: 'string' } }, required: ['pointer'] },
    execute: async (args: any) => ({ content: [{ type: 'text', text: `got ${JSON.stringify(args)}` }] })
  }
  const pathParams = [
    { name: 'id', schema: { type: 'string', title: 'Collection' }, required: true },
    { name: 'lineId', schema: { type: 'string' }, required: true }
  ]

  it('adds the path parameters to the input schema and keeps the original required', () => {
    const tool = bridgeTool(formTool, pathParams as any, async () => formTool)
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id', 'lineId', 'pointer'])
    assert.deepEqual(tool.inputSchema.required, ['id', 'lineId', 'pointer'])
  })

  it('passes only the non-path arguments to the session tool', async () => {
    const tool = bridgeTool(formTool, pathParams as any, async () => formTool)
    const result = await tool.execute({ id: 'cities', lineId: 'abc', pointer: '/nom' })
    assert.equal(result.text, 'got {"pointer":"/nom"}')
  })

  it('turns a resolver failure into an error result rather than a throw', async () => {
    const tool = bridgeTool(formTool, pathParams as any, async () => { throw new Error('schema fetch failed: 404') })
    const result = await tool.execute({ id: 'cities', lineId: 'abc', pointer: '/nom' })
    assert.equal(result.isError, true)
    assert.match(result.text, /schema fetch failed: 404/)
  })

  it('reports a missing path parameter without calling the resolver', async () => {
    let called = false
    const tool = bridgeTool(formTool, pathParams as any, async () => { called = true; return formTool })
    const result = await tool.execute({ pointer: '/nom' })
    assert.equal(result.isError, true)
    assert.match(result.text, /id/)
    assert.equal(called, false)
  })
})

describe('isReadOnlyFormTool', () => {
  it('marks the reads read-only and every write, save or reload not', () => {
    for (const verb of ['describeState', 'getData', 'getFieldSuggestions', 'openSection']) {
      assert.equal(isReadOnlyFormTool(`page_config_${verb}`), true, verb)
      assert.equal(isReadOnlyFormTool(verb), true, verb)
    }
    for (const verb of ['setData', 'setFieldValue', 'editArray', 'saveForm', 'reloadForm']) {
      assert.equal(isReadOnlyFormTool(`page_config_${verb}`), false, verb)
    }
  })

  it('gives the bridged tool its annotation', () => {
    const tool = (name: string) => bridgeTool({ name, description: '', execute: async () => ({}) }, [], async () => { throw new Error('unused') })
    assert.deepEqual(tool('item_getData').annotations, { readOnlyHint: true })
    assert.deepEqual(tool('item_setData').annotations, { readOnlyHint: false })
  })

  it('titles every form tool with the operation title and a verb label in the locale', () => {
    const tool = (name: string, locale?: string) => bridgeTool({ name, description: '', execute: async () => ({}) }, [], async () => { throw new Error('unused') }, undefined, { operationTitle: 'Page', locale })
    assert.equal(tool('portals_page_config_saveForm', 'fr').annotations.title, 'Page — enregistrer')
    assert.equal(tool('portals_page_config_editArray', 'fr').annotations.title, 'Page — modifier une liste')
    assert.equal(tool('portals_page_config_saveForm', 'en').annotations.title, 'Page — save')
    assert.equal(tool('getData').annotations.title, 'Page — read')
    assert.deepEqual(tool('item_getData', 'fr').annotations, { title: 'Page — lire', readOnlyHint: true })
    for (const verb of Object.keys(FORM_VERB_LABELS)) assert.ok(formToolTitle(`x_${verb}`, 'T', 'fr')?.startsWith('T — '), verb)
    assert.equal(formToolTitle('x_unknown', 'T'), undefined)
  })

  it('carries the operation\'s openWorldHint to every verb', () => {
    const tool = (name: string, openWorldHint?: boolean) => bridgeTool({ name, description: '', execute: async () => ({}) }, [], async () => { throw new Error('unused') }, openWorldHint)
    assert.deepEqual(tool('item_getData', false).annotations, { readOnlyHint: true, openWorldHint: false })
    assert.deepEqual(tool('item_saveForm', false).annotations, { readOnlyHint: false, openWorldHint: false })
    assert.deepEqual(tool('item_getData').annotations, { readOnlyHint: true })
  })
})
