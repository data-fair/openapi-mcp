import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bridgeTool, toToolResult } from '../src/editor/bridge.ts'

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
    name: 'dataset_line_setFieldValue',
    description: 'Set one field',
    inputSchema: { type: 'object', properties: { pointer: { type: 'string' } }, required: ['pointer'] },
    execute: async (args: any) => ({ content: [{ type: 'text', text: `got ${JSON.stringify(args)}` }] })
  }
  const pathParams = [
    { name: 'id', schema: { type: 'string', title: 'Dataset' }, required: true },
    { name: 'lineId', schema: { type: 'string' }, required: true }
  ]

  it('adds the path parameters to the input schema and keeps the original required', () => {
    const tool = bridgeTool(formTool, pathParams as any, async () => formTool)
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id', 'lineId', 'pointer'])
    assert.deepEqual(tool.inputSchema.required, ['id', 'lineId', 'pointer'])
  })

  it('passes only the non-path arguments to the session tool', async () => {
    const tool = bridgeTool(formTool, pathParams as any, async () => formTool)
    const result = await tool.execute({ id: 'communes', lineId: 'abc', pointer: '/nom' })
    assert.equal(result.text, 'got {"pointer":"/nom"}')
  })

  it('turns a resolver failure into an error result rather than a throw', async () => {
    const tool = bridgeTool(formTool, pathParams as any, async () => { throw new Error('schema fetch failed: 404') })
    const result = await tool.execute({ id: 'communes', lineId: 'abc', pointer: '/nom' })
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
