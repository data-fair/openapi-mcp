import { currentCall } from '../context.ts'
import type { CallContext, JsonSchema, ResolvedParam, Tool, ToolAnnotations, ToolResult } from '../types.ts'

/** The shape @json-layout/agents hands us; typed here so this module need not import the optional peer. */
export interface FormTool {
  name: string
  description: string
  inputSchema?: JsonSchema
  execute (args?: Record<string, unknown>): Promise<{ content?: { type: string, text?: string }[], isError?: boolean }>
}

export function toToolResult (result: { content?: { type: string, text?: string }[], isError?: boolean }): ToolResult {
  const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
  return { text, isError: result.isError }
}

/**
 * The package tools that change neither the record nor the form's data. Every other one
 * writes (setData, setFieldValue, editArray), persists (saveForm) or drops local changes
 * (reloadForm). A reviewer gating writes on readOnlyHint sends a read marked as a write to
 * the person for approval: simulations stalled on describeState and getData doing exactly that.
 */
const READ_ONLY_VERBS = ['describeState', 'getData', 'getFieldSuggestions', 'openSection']

/** Whether a package tool, named `<prefix>_<verb>` or bare `<verb>`, only reads. */
export function isReadOnlyFormTool (name: string): boolean {
  return READ_ONLY_VERBS.some(verb => name === verb || name.endsWith(`_${verb}`))
}

/** The verb labels of the form tools, so a card's heading reads `Page — enregistrer`, not `portals_page_config_saveForm`. */
export const FORM_VERB_LABELS: Record<string, { fr: string, en: string }> = {
  describeState: { fr: 'état du formulaire', en: 'form state' },
  getData: { fr: 'lire', en: 'read' },
  setFieldValue: { fr: 'modifier un champ', en: 'set a field' },
  setData: { fr: 'modifier', en: 'set fields' },
  getFieldSuggestions: { fr: 'valeurs proposées', en: 'suggestions' },
  editArray: { fr: 'modifier une liste', en: 'edit a list' },
  saveForm: { fr: 'enregistrer', en: 'save' },
  reloadForm: { fr: 'recharger', en: 'reload' }
}

/** `${operation title} — ${verb label}` for a package tool named `<prefix>_<verb>` or `<verb>`, in the locale's language (fr, else en). */
export function formToolTitle (name: string, operationTitle: string, locale?: string): string | undefined {
  const verb = Object.keys(FORM_VERB_LABELS).find(v => name === v || name.endsWith(`_${v}`))
  if (!verb) return undefined
  return `${operationTitle} — ${FORM_VERB_LABELS[verb][locale?.toLowerCase().startsWith('fr') ? 'fr' : 'en']}`
}

/**
 * One package tool, addressed by resource.
 *
 * The package's tools have fixed input schemas and no notion of which record is being
 * edited, so the path parameters are added here and stripped back off before delegating.
 * `resolve` opens or resumes the session for those parameters. `openWorldHint` is the write operation's own
 * (x-agent annotations): whether the record holds outside content is the API's to say, for every verb alike.
 * `titling` gives each tool an `annotations.title`.
 */
export function bridgeTool (descriptor: FormTool, pathParams: ResolvedParam[], resolve: (pathValues: Record<string, unknown>, ctx: CallContext | undefined) => Promise<FormTool>, openWorldHint?: boolean, titling?: { operationTitle: string, locale?: string }): Tool {
  const title = titling ? formToolTitle(descriptor.name, titling.operationTitle, titling.locale) : undefined
  const properties: Record<string, unknown> = {}
  for (const p of pathParams) properties[p.name] = p.schema
  for (const [k, v] of Object.entries(descriptor.inputSchema?.properties ?? {})) properties[k] = v

  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: {
      type: 'object',
      properties,
      required: [...pathParams.map(p => p.name), ...(descriptor.inputSchema?.required ?? [])]
    },
    annotations: { ...(title ? { title } : {}), readOnlyHint: isReadOnlyFormTool(descriptor.name), ...(openWorldHint === undefined ? {} : { openWorldHint }) } satisfies ToolAnnotations,
    async execute (params: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult> {
      const pathValues: Record<string, unknown> = {}
      for (const p of pathParams) {
        const value = params?.[p.name]
        if (value === undefined || value === null) return { isError: true, text: `Missing required parameter "${p.name}".` }
        pathValues[p.name] = value
      }
      const rest = { ...params }
      for (const p of pathParams) delete rest[p.name]
      try {
        // The session's own requests (schema, load, save) carry this call's context:
        // credentials captured when the session was opened may have expired.
        return await currentCall.run(ctx, async () => {
          const tool = await resolve(pathValues, ctx)
          return toToolResult(await tool.execute(rest))
        })
      } catch (err) {
        // A failed open — schema fetch, document load, a compile error — is a datum the
        // agent can act on, not a crash. Same contract as every other tool here.
        return { isError: true, text: `Error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }
}
