import { resolveEditorOperations } from './operations.ts'
import { buildSessionSpec, createSchemaRegistry, type EditorContext } from './session-spec.ts'
import { bridgeTool, type FormTool } from './bridge.ts'
import type { ResolvedOperation, Tool } from '../types.ts'

export type { EditorContext } from './session-spec.ts'

const STUB_SPEC = {
  title: 'form',
  load: () => ({}),
  schema: () => ({ type: 'object', properties: {} })
}

/**
 * The eight tools of one editor group.
 *
 * Descriptors come from a throwaway session over a literal stub: `getTools()` throws
 * while a session is closed, but `load()` must publish names, descriptions and input
 * schemas before any record is named and without touching the API. Taking them from the
 * package rather than retyping them keeps the text an agent reads in one place.
 */
export async function buildEditorTools (op: ResolvedOperation, ctx: EditorContext): Promise<Tool[]> {
  const { createFormSession, createSessionStore } = await import('@json-layout/agents')
  const ops = resolveEditorOperations(op, ctx.doc)
  const registry = createSchemaRegistry()
  const store = createSessionStore<any>()
  const pathParams = op.params.filter(p => p.in === 'path')

  const bootstrap = createFormSession({ ...STUB_SPEC, prefixName: `${op.toolName}_` } as any)
  await bootstrap.open()
  const descriptors: FormTool[] = bootstrap.getTools()
  bootstrap.close()

  return descriptors.map(descriptor => bridgeTool(descriptor, pathParams, async (pathValues) => {
    const key = `${op.toolName}:${pathParams.map(p => String(pathValues[p.name])).join(':')}`
    const session = await store.getOrCreate(key, async () => {
      const created = createFormSession(buildSessionSpec(ops, pathValues, ctx, registry) as any)
      await created.open()
      return created
    })
    const tool = session.getTools().find((t: FormTool) => t.name === descriptor.name)
    if (!tool) throw new Error(`the session has no tool named "${descriptor.name}"`)
    return tool
  }))
}
