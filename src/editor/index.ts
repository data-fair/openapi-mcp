import { buildSessionSpec, createSchemaRegistry, type EditorContext } from './session-spec.ts'
import { bridgeTool, neutralText, FORM_ARG, FORM_PREFIX, type EditorForm, type FormTool } from './bridge.ts'
import { uncheckedLine } from './server-copy.ts'
import { localize } from '../localize.ts'
import type { EditorOperations } from './operations.ts'
import type { Tool } from '../types.ts'

/** Stands for the form title in the bootstrap session's text, then taken out by neutralText. */
const SENTINEL = 'FORMTITLESENTINEL'

const STUB_SPEC = {
  load: () => ({}),
  schema: () => ({ type: 'object', properties: {} }),
  // never called: every editor operation has a write operation, and a session without a save
  // function publishes itself read-only (no `save` option on its writes, a skill that says
  // saveForm refuses)
  save: async () => ({ version: undefined }),
  title: SENTINEL,
  prefixName: FORM_PREFIX
}

/** One editor operation of the document, resolved, with the agent guide its declared schema carries. */
export interface EditorEntry {
  ops: EditorOperations
  /** the `x-agent-guide` of the declared request body, after prepareEditorSchema; unknown for a fetched schema */
  guide?: string
}

export interface EditorGroup {
  tools: Tool[]
  /** the json-layout fill-form skill over every form, with each declared schema's guide */
  skill: string
  /** each form's value of `form` and its title */
  forms: { name: string, title: string }[]
}

/**
 * The form tools of a document: one group over every editor operation, the operation chosen
 * per call by the `form` argument. Eight tools whatever the number of forms.
 *
 * Descriptors come from a throwaway session over a literal stub: `getTools()` throws
 * while a session is closed, but `load()` must publish names, descriptions and input
 * schemas before any record is named and without touching the API. Taking them from the
 * package rather than retyping them keeps the text an agent reads in one place.
 */
export async function buildEditorGroup (entries: EditorEntry[], ctx: EditorContext): Promise<EditorGroup> {
  const { createFormSession, createSessionStore } = await import('@json-layout/agents')
  const registry = createSchemaRegistry()
  const store = createSessionStore<any>()

  const bootstrap = createFormSession(STUB_SPEC as any)
  await bootstrap.open()
  const descriptors: FormTool[] = bootstrap.getTools().map((t: FormTool) => ({ ...t, description: neutralText(t.description, SENTINEL) }))
  const genericSkill = neutralText(bootstrap.getSkill(), SENTINEL)
  bootstrap.close()

  const forms: EditorForm[] = entries.map(({ ops }) => {
    const op = ops.write
    const pathParams = op.params.filter(p => p.in === 'path')
    return {
      name: op.toolName,
      title: localize(op.agent.title, ctx.locale) ?? op.operationId,
      pathParams,
      openWorldHint: op.agent.annotations?.openWorldHint,
      security: op.security,
      async resolve (toolName, pathValues, callCtx) {
        // One session per caller, form and record: two users editing the same record must not
        // share one. Without an identity the process is one caller (stdio) and sessions are global.
        const key = `${callCtx?.identity ?? ''}:${op.toolName}:${pathParams.map(p => String(pathValues[p.name])).join(':')}`
        const session = await store.getOrCreate(key, async () => {
          const created: any = createFormSession(buildSessionSpec(ops, pathValues, ctx, registry, () => { created.uncheckedSave = true }) as any)
          await created.open()
          return created
        })
        const tool: FormTool | undefined = session.getTools().find((t: FormTool) => t.name === toolName)
        if (!tool) throw new Error(`the session has no tool named "${toolName}"`)
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
            return { ...result, content: [...(result.content ?? []), { type: 'text', text: uncheckedLine(`${FORM_PREFIX}reloadForm with ${FORM_ARG} "${op.toolName}"`) }] }
          }
        }
      }
    }
  })

  const tools = descriptors.map(descriptor => bridgeTool(descriptor, forms, ctx.locale))
  return { tools, skill: groupSkill(genericSkill, entries, forms, ctx.locale), forms: forms.map(f => ({ name: f.name, title: f.title })) }
}

/** The generic guide to the tools, then the forms and the guide of each declared schema. */
function groupSkill (generic: string, entries: EditorEntry[], forms: EditorForm[], locale: string): string {
  const list = forms.map((f, i) => {
    const params = f.pathParams.map(p => p.name)
    // the operation's x-agent description: what a tool's description would have said of it
    const description = localize(entries[i].ops.write.agent.description, locale)?.trim()
    return `- \`${f.name}\`: ${f.title}${params.length ? ` (${params.join(', ')})` : ''}${description ? `. ${description}` : ''}`
  }).join('\n')
  const about = entries.flatMap(({ guide }, i) => guide?.trim()
    ? [`## About ${forms[i].title} (${FORM_ARG}: "${forms[i].name}")\n\n${guide.trim()}`]
    : [])
  return [
    generic.trimEnd(),
    `## Forms\n\nEvery ${FORM_PREFIX}* tool takes "${FORM_ARG}", the form it edits, and the parameters naming its document; each form and document keeps its own edits until saved or reloaded.\n\n${list}`,
    ...about
  ].join('\n\n') + '\n'
}
