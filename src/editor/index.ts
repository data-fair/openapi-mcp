import { resolveEditorOperations } from './operations.ts'
import { buildSessionSpec, createSchemaRegistry, type EditorContext } from './session-spec.ts'
import { bridgeTool, type FormTool } from './bridge.ts'
import { uncheckedLine } from './server-copy.ts'
import { localize } from '../localize.ts'
import type { ResolvedOperation, Tool } from '../types.ts'

const STUB_SPEC = {
  load: () => ({}),
  schema: () => ({ type: 'object', properties: {} }),
  // never called: every editor group has a write operation, and a session without a save
  // function publishes itself read-only (no `save` option on its writes, a skill that says
  // saveForm refuses)
  save: async () => ({ version: undefined })
}

interface EditorGroup {
  tools: Tool[]
  /**
   * The json-layout fill-form skill of the group: how to use its tools and, when the schema
   * is the declared request body, the "About this …" section of its x-agent-guide. A schema
   * fetched per record is unknown here, so its skill stays generic.
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
  const operationTitle = localize(op.agent.title, ctx.locale) ?? op.operationId
  const bootstrap = createFormSession({
    ...STUB_SPEC,
    ...(declared ? { schema: async () => await ctx.prepareSchema(structuredClone(declared)) } : {}),
    // The title is the same expression buildSessionSpec uses: the package interpolates it
    // into every tool description, so published and runtime text must not drift.
    title: operationTitle,
    prefixName: `${op.toolName}_`
  } as any)
  await bootstrap.open()
  const descriptors: FormTool[] = bootstrap.getTools()
  const skill: string = bootstrap.getSkill()
  bootstrap.close()

  const bridged = descriptors.map(descriptor => bridgeTool(descriptor, pathParams, async (pathValues, callCtx) => {
    // One session per caller and record: two users editing the same record must not share
    // one. Without an identity the process is one caller (stdio) and sessions are global.
    const key = `${callCtx?.identity ?? ''}:${op.toolName}:${pathParams.map(p => String(pathValues[p.name])).join(':')}`
    const session = await store.getOrCreate(key, async () => {
      const created: any = createFormSession(buildSessionSpec(ops, pathValues, ctx, registry, () => { created.uncheckedSave = true }) as any)
      await created.open()
      return created
    })
    const tool: FormTool | undefined = session.getTools().find((t: FormTool) => t.name === descriptor.name)
    if (!tool) throw new Error(`the session has no tool named "${descriptor.name}"`)
    // A session that creates records empties its form after a save: nothing to check.
    if (!ops.read) return tool
    return {
      ...tool,
      async execute (args) {
        session.uncheckedSave = false
        const result = await tool.execute(args)
        const unchecked = session.uncheckedSave === true
        session.uncheckedSave = false
        if (!unchecked || result.isError) return result
        return { ...result, content: [...(result.content ?? []), { type: 'text', text: uncheckedLine(`${op.toolName}_reloadForm`) }] }
      }
    }
  }, op.agent.annotations?.openWorldHint, { operationTitle, locale: ctx.locale }))
  // Every tool of the group drives the one operation, so each carries its security.
  const tools = bridged.map(tool => ({ ...tool, security: op.security }))
  return { tools, skill }
}
