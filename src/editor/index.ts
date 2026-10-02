import { resolveEditorOperations } from './operations.ts'
import { buildSessionSpec, createSchemaRegistry, type EditorContext } from './session-spec.ts'
import { bridgeTool, type FormTool } from './bridge.ts'
import { localize } from '../localize.ts'
import { prepareSchema } from './prepare-schema.ts'
import type { ResolvedOperation, Tool } from '../types.ts'

export type { EditorContext } from './session-spec.ts'

const STUB_SPEC = {
  load: () => ({}),
  schema: () => ({ type: 'object', properties: {} })
}

export interface EditorGroup {
  tools: Tool[]
  /**
   * The json-layout fill-form skill of the group: how to use its tools and, when the schema
   * is the declared request body, the "About this …" section of its x-agent-guide. A schema
   * fetched per record (a dataset's lines) is unknown here, so its skill stays generic.
   */
  skill: string
}

/**
 * The eight tools of one editor group, and its skill.
 *
 * Descriptors come from a throwaway session over a literal stub: `getTools()` throws
 * while a session is closed, but `load()` must publish names, descriptions and input
 * schemas before any record is named and without touching the API. Taking them from the
 * package rather than retyping them keeps the text an agent reads in one place.
 */
export async function buildEditorTools (op: ResolvedOperation, ctx: EditorContext): Promise<EditorGroup> {
  const { createFormSession, createSessionStore } = await import('@json-layout/agents')
  const ops = resolveEditorOperations(op, ctx.doc)
  const registry = createSchemaRegistry()
  const store = createSessionStore<any>()
  const pathParams = op.params.filter(p => p.in === 'path')

  // A declared request-body schema is known now, and it is what carries the agent guide; it
  // costs no request. A schema behind an operation would, so that one stays the stub.
  const declared = ops.schema ? undefined : ops.write.requestBody?.schema
  const bootstrap = createFormSession({
    ...STUB_SPEC,
    ...(declared ? { schema: async () => await prepareSchema(declared) } : {}),
    // The title is the same expression buildSessionSpec uses: the package interpolates it
    // into every tool description, so published and runtime text must not drift.
    title: localize(op.agent.title, ctx.locale) ?? op.operationId,
    prefixName: `${op.toolName}_`
  } as any)
  await bootstrap.open()
  const descriptors: FormTool[] = bootstrap.getTools()
  const skill: string = bootstrap.getSkill()
  bootstrap.close()

  const tools = descriptors.map(descriptor => bridgeTool(descriptor, pathParams, async (pathValues, callCtx) => {
    // One session per caller and record: two users editing the same record must not share
    // one. Without an identity the process is one caller (stdio) and sessions are global.
    const key = `${callCtx?.identity ?? ''}:${op.toolName}:${pathParams.map(p => String(pathValues[p.name])).join(':')}`
    const session = await store.getOrCreate(key, async () => {
      const created = createFormSession(buildSessionSpec(ops, pathValues, ctx, registry) as any)
      await created.open()
      return created
    })
    const tool = session.getTools().find((t: FormTool) => t.name === descriptor.name)
    if (!tool) throw new Error(`the session has no tool named "${descriptor.name}"`)
    return tool
  }))
  return { tools, skill }
}
