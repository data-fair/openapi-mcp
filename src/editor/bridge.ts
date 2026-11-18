import { currentCall } from '../context.ts'
import { granted } from '../scopes.ts'
import { localize } from '../localize.ts'
import type { CallContext, JsonSchema, ResolvedParam, SecurityRequirement, Tool, ToolAnnotations, ToolResult } from '../types.ts'

/** The shape @json-layout/agents hands us; typed here so this module need not import the optional peer. */
export interface FormTool {
  name: string
  description: string
  inputSchema?: JsonSchema
  execute (args?: Record<string, unknown>): Promise<{ content?: { type: string, text?: string }[], isError?: boolean }>
}

/** The prefix of every form tool of a document: one group, whatever the number of editor operations. */
export const FORM_PREFIX = 'form_'

/** The input naming which form a call edits. */
export const FORM_ARG = 'form'

/** One editor operation, as a value of a form tool's `form` argument. */
export interface EditorForm {
  /** the operation's tool name: the value of `form` */
  name: string
  title: string
  /** the write operation's path parameters: which document of this form a call edits */
  pathParams: ResolvedParam[]
  /** the write operation's x-agent openWorldHint */
  openWorldHint?: boolean
  security?: SecurityRequirement[]
  /** opens or resumes the session for these path values and returns its tool of that name */
  resolve (toolName: string, pathValues: Record<string, unknown>, ctx: CallContext | undefined): Promise<FormTool>
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

/** The verb labels of the form tools, so a card's heading reads `Page — enregistrer`, not `portals_form_saveForm`. */
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

/** What heads a form tool offering several forms: the call's `form` argument says which. */
export const FORM_GROUP_LABEL = { fr: 'Formulaire', en: 'Form' }

const lang = (locale?: string) => locale?.toLowerCase().startsWith('fr') ? 'fr' : 'en'

/** `${title} — ${verb label}` for a package tool named `<prefix>_<verb>` or `<verb>`, in the locale's language (fr, else en). */
export function formToolTitle (name: string, title: string, locale?: string): string | undefined {
  const verb = Object.keys(FORM_VERB_LABELS).find(v => name === v || name.endsWith(`_${v}`))
  if (!verb) return undefined
  return `${title} — ${FORM_VERB_LABELS[verb][lang(locale)]}`
}

/** true when one form's write is open-world, false when all say they are not, else unsaid (MCP's default: open). */
function mergedOpenWorld (forms: EditorForm[]): boolean | undefined {
  if (forms.some(f => f.openWorldHint === true)) return true
  if (forms.length && forms.every(f => f.openWorldHint === false)) return false
  return undefined
}

/** Every alternative of every form's security: the tool is offered when one form is. */
function mergedSecurity (forms: EditorForm[]): SecurityRequirement[] | undefined {
  if (forms.some(f => !f.security)) return undefined
  const seen = new Map<string, SecurityRequirement>()
  for (const f of forms) for (const r of f.security!) seen.set(JSON.stringify(r), r)
  return [...seen.values()]
}

// `"name": title`, not `title (name)`: a title often has its own parenthesis
const formList = (forms: EditorForm[]) => forms.map(f => `"${f.name}": ${f.title}`).join('; ')

/**
 * The input properties naming a document: the path parameters of every form, merged by name.
 * A name several forms share is one property; when its meaning differs per form, its
 * description says which is which, and differing schemas become an `anyOf`.
 */
function pathProperties (forms: EditorForm[], locale?: string): { properties: Record<string, JsonSchema>, required: string[] } {
  const byName = new Map<string, { form: string, param: ResolvedParam }[]>()
  for (const f of forms) {
    for (const p of f.pathParams) {
      const list = byName.get(p.name) ?? []
      list.push({ form: f.name, param: p })
      byName.set(p.name, list)
    }
  }
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [name, uses] of byName) {
    const schemas = uses.map(u => { const { description, ...rest } = u.param.schema ?? {}; return rest })
    // the x-agent override first, as on any other tool's parameter
    const descriptions = uses.map(u => localize(u.param.agent?.description, locale ?? 'en') ?? u.param.description ?? u.param.schema?.description)
    const sameSchema = schemas.every(s => JSON.stringify(s) === JSON.stringify(schemas[0]))
    const sameDescription = descriptions.every(d => d === descriptions[0])
    let description: string | undefined
    if (sameDescription) description = descriptions[0]
    else description = uses.map((u, i) => `for "${u.form}": ${(descriptions[i] ?? name).replace(/\.\s*$/, '')}`).join('; ') + '.'
    if (uses.length < forms.length) {
      const which = `Only for form ${uses.map(u => `"${u.form}"`).join(', ')}.`
      description = description ? `${description} ${which}` : which
    }
    const schema: JsonSchema = sameSchema
      ? { ...schemas[0] }
      : { anyOf: [...new Map(schemas.map(s => [JSON.stringify(s), s])).values()] }
    properties[name] = description ? { ...schema, description } : schema
    if (uses.length === forms.length) required.push(name)
  }
  return { properties, required }
}

/**
 * One package tool over every form of a document.
 *
 * The package's tools have fixed input schemas and no notion of which form or record is
 * being edited, so `form` and the path parameters are added here and stripped back off
 * before delegating. `descriptor` is the bootstrap session's tool, its text already made
 * form-neutral. `forScopes` narrows `form` to the forms a token's scopes grant.
 */
export function bridgeTool (descriptor: FormTool, forms: EditorForm[], locale?: string): Tool {
  const paths = pathProperties(forms, locale)
  const allPathNames = Object.keys(paths.properties)
  // One form left (a single editor, or a token granted one): the card can name it.
  const heading = forms.length === 1 ? forms[0].title : FORM_GROUP_LABEL[lang(locale)]
  const title = formToolTitle(descriptor.name, heading, locale)
  const openWorldHint = mergedOpenWorld(forms)
  const properties: Record<string, unknown> = {
    [FORM_ARG]: {
      type: 'string',
      enum: forms.map(f => f.name),
      description: `The form this call edits. ${formList(forms)}. A form keeps its edits between calls with the same form and parameters.`
    },
    ...paths.properties
  }
  for (const [k, v] of Object.entries(descriptor.inputSchema?.properties ?? {})) properties[k] = v

  const tool: Tool = {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: {
      type: 'object',
      properties,
      required: [FORM_ARG, ...paths.required, ...(descriptor.inputSchema?.required ?? [])]
    },
    annotations: { ...(title ? { title } : {}), readOnlyHint: isReadOnlyFormTool(descriptor.name), ...(openWorldHint === undefined ? {} : { openWorldHint }) } satisfies ToolAnnotations,
    security: mergedSecurity(forms),
    forScopes (scopes) {
      const kept = forms.filter(f => granted(f.security, scopes))
      if (!kept.length) return undefined
      return kept.length === forms.length ? tool : bridgeTool(descriptor, kept, locale)
    },
    async execute (params: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult> {
      const form = forms.find(f => f.name === params?.[FORM_ARG])
      if (!form) return { isError: true, text: `"${FORM_ARG}" must name one of the forms: ${formList(forms)}.` }
      const own = new Set(form.pathParams.map(p => p.name))
      const foreign = allPathNames.filter(n => !own.has(n) && params[n] !== undefined && params[n] !== null)
      if (foreign.length) return { isError: true, text: `Form "${form.name}" takes no parameter ${foreign.map(n => `"${n}"`).join(', ')}.` }
      const pathValues: Record<string, unknown> = {}
      for (const p of form.pathParams) {
        const value = params[p.name]
        if (value === undefined || value === null) return { isError: true, text: `Missing required parameter "${p.name}" of form "${form.name}".` }
        pathValues[p.name] = value
      }
      const rest = { ...params }
      delete rest[FORM_ARG]
      for (const n of allPathNames) delete rest[n]
      try {
        // The session's own requests (schema, load, save) carry this call's context:
        // credentials captured when the session was opened may have expired.
        return await currentCall.run(ctx, async () => {
          const session = await form.resolve(descriptor.name, pathValues, ctx)
          return toToolResult(await session.execute(rest))
        })
      } catch (err) {
        // A failed open — schema fetch, document load, a compile error — is a datum the
        // agent can act on, not a crash. Same contract as every other tool here.
        return { isError: true, text: `Error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }
  return tool
}

/**
 * The package's text with the bootstrap title taken out. The package writes the title of the
 * form it edits into every description and the skill; one tool serving several forms has no
 * single title, so the sentences are rewritten to speak of "the form", the one `form` names.
 */
export function neutralText (text: string, sentinel: string): string {
  const q = `"${sentinel}"`
  return text
    .replaceAll(`JSON ${sentinel} Form-Filling Guide`, 'JSON Form-Filling Guide')
    .replaceAll(`the ${q} form`, 'the form')
    .replaceAll(`the current ${q} data`, 'the form\'s current data')
    .replaceAll(`several ${q} fields`, 'several fields of the form')
    .replaceAll(`of ${q}`, 'of the form')
    .replaceAll(q, 'the form')
    .replaceAll(sentinel, 'form')
}
