import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats'
import Debug from 'debug'
import { loadSpec, resolveOperations, defaultProfile } from './spec.ts'
import { expandProfiles, selectProfiles } from './profiles.ts'
import { buildEditorTools } from './editor/index.ts'
import { buildInput } from './input.ts'
import { buildRequest } from './request.ts'
import { render } from './render.ts'
import { localize } from './localize.ts'
import { callFetch, contextualFetch } from './context.ts'
import { lintToolInput, formatFindings, type LintFinding } from './vocabulary/lint.ts'
import type { JsonSchema, ResolvedOperation, Tool, ToolResult, ToolSet, AgentRoot, AgentTag } from './types.ts'

const debug = Debug('openapi-mcp')
// ajv-formats is a CJS package whose module.exports is reassigned to a callable value; under
// NodeNext, TS types the default import as the whole (non-callable) module namespace rather
// than the callable value, so it needs a cast back to its declared type.
const addFormats = addFormatsModule as unknown as FormatsPlugin

export interface LoadOptions {
  /** one profile; `profiles` wins when both are given */
  profile?: string
  /** a set of profiles; an operation in any of them (after `includes` expansion) is selected once */
  profiles?: string[]
  /** replaces the document's `x-agent.namePrefix` (`''` strips it) */
  namePrefix?: string
  fetch?: typeof fetch
  locale?: string
  baseUrl?: string
  structuredContent?: boolean
  maxStringLength?: number
  maxErrorLength?: number
  /**
   * What to do when a description an annotation authored contradicts the schema it
   * describes. 'error' (the default) refuses to build the tool set, listing every
   * disagreement at once. 'warn' prints them and continues, for the case where the
   * heuristic is wrong and you need to ship anyway. 'off' skips the check.
   */
  lint?: 'error' | 'warn' | 'off'
}

const ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults: true, coerceTypes: false })
addFormats(ajv)

export function buildInstructions (doc: JsonSchema, profiles: string[], ops: ResolvedOperation[], locale: string): string {
  const root: AgentRoot = doc['x-agent'] ?? {}
  const selected = selectProfiles(profiles, expandProfiles(root.profiles))
  const sections: string[] = []
  for (const skill of root.skills ?? []) {
    if (skill.profiles && !skill.profiles.some(p => selected.has(p))) continue
    let text = `## ${skill.name}\n\n${localize(skill.description, locale)}`
    if (skill.tools?.length) text += `\n\nTools: ${skill.tools.join(', ')}`
    sections.push(text)
  }
  const usedTags = new Set(ops.flatMap(o => o.tags))
  for (const tag of doc.tags ?? []) {
    const agent: AgentTag | undefined = tag?.['x-agent']
    if (!agent?.skill || !usedTags.has(tag.name)) continue
    sections.push(`## ${tag.name}\n\n${localize(agent.skill, locale)}`)
  }
  return sections.join('\n\n')
}

function errorsText (validate: ValidateFunction): string {
  return (validate.errors ?? []).map(e => `${e.instancePath || 'params'} ${e.message}`).join('; ')
}

function makeTool (op: ResolvedOperation, o: Required<Omit<LoadOptions, 'profile' | 'profiles' | 'namePrefix'>>): Tool & { authoredDescriptions: Set<string> } {
  const { inputSchema, bindings, authoredDescriptions, bodySchema } = buildInput(op, o.locale)
  const validate = ajv.compile(inputSchema)
  // In compact mode the tool's own schema describes the body only as `object`, so the real
  // one validates it here. This is the point of summarising rather than dropping: a
  // caller that misreads the listing gets a path and a keyword locally instead of a round
  // trip and whatever the API says — blind repair is the failure mode this avoids.
  const validateBody = bodySchema ? ajv.compile(bodySchema) : undefined
  const description = (localize(op.agent.description, o.locale) ?? [op.summary, op.description].filter(Boolean).join('\n\n')).trim()
  const tool: Tool & { authoredDescriptions: Set<string> } = {
    name: op.toolName,
    authoredDescriptions,
    title: localize(op.agent.title, o.locale),
    description: description || op.operationId,
    inputSchema,
    outputSchema: o.structuredContent ? op.responseSchema : undefined,
    annotations: { readOnlyHint: op.method === 'GET' || op.method === 'HEAD', destructiveHint: op.method === 'DELETE', ...(op.agent.annotations ?? {}) },
    examples: op.agent.examples,
    async execute (rawParams, ctx): Promise<ToolResult> {
      const params = structuredClone(rawParams ?? {})
      if (!validate(params)) return { isError: true, text: `Invalid parameters: ${errorsText(validate)}` }
      if (validateBody && !validateBody(params.body)) {
        return { isError: true, text: `Invalid body: ${errorsText(validateBody)}` }
      }
      let res: Response
      try {
        const req = buildRequest(op, bindings, params, o.baseUrl)
        debug('%s %s', req.method, req.url)
        res = await callFetch(req, ctx, o.fetch)
      } catch (err: any) {
        return { isError: true, text: `Request failed: ${err?.message ?? err}` }
      }
      if (!res.ok) {
        const body = await res.text()
        const truncated = body.length > o.maxErrorLength ? body.slice(0, o.maxErrorLength) + '…' : body
        return { isError: true, text: `HTTP ${res.status}: ${truncated}` }
      }
      const contentType = res.headers.get('content-type') ?? ''
      const body = await res.text()
      if (!body.trim()) return { text: 'OK' }
      if (contentType.startsWith('application/json')) {
        let json: unknown
        try {
          json = JSON.parse(body)
        } catch (err: any) {
          return { isError: true, text: `Invalid JSON response: ${err?.message ?? err}` }
        }
        const text = render(json, {
          schema: op.responseSchema,
          response: op.agent.response,
          fields: Array.isArray(params.fields) ? params.fields as string[] : undefined,
          responseFormat: params.response_format as 'concise' | 'detailed' | undefined,
          locale: o.locale,
          maxStringLength: o.maxStringLength
        })
        return o.structuredContent ? { text, structuredContent: json } : { text }
      }
      return { text: body }
    }
  }
  return tool
}

export async function load (spec: string | JsonSchema, options: LoadOptions = {}): Promise<ToolSet> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const doc = await loadSpec(spec, fetchFn)
  const declared = Object.keys((doc['x-agent'] as AgentRoot | undefined)?.profiles ?? {})
  const profiles = options.profiles ?? (options.profile ? [options.profile] : [defaultProfile(doc)])
  if (!profiles.length) throw new Error('profiles must name at least one profile')
  for (const p of profiles) {
    if (declared.length && !declared.includes(p)) throw new Error(`unknown profile "${p}" (declared: ${declared.join(', ')})`)
  }
  const baseUrl = options.baseUrl ?? doc.servers?.[0]?.url
  if (!baseUrl) throw new Error('no base URL: pass options.baseUrl or declare servers[0] in the document')
  const o = {
    fetch: fetchFn,
    locale: options.locale ?? 'en',
    baseUrl,
    structuredContent: options.structuredContent ?? false,
    maxStringLength: options.maxStringLength ?? 500,
    maxErrorLength: options.maxErrorLength ?? 4000,
    lint: options.lint ?? 'error'
  }
  const ops = resolveOperations(doc, profiles, { namePrefix: options.namePrefix })
  const editorOps = ops.filter(op => op.agent.editor)
  const plainOps = ops.filter(op => !op.agent.editor)
  const built = plainOps.map(op => makeTool(op, o))

  if (o.lint !== 'off') {
    const findings: LintFinding[] = built.flatMap(t => lintToolInput(t.name, t.inputSchema, t.authoredDescriptions))
    if (findings.length) {
      // Reported all at once: fixing one and rerunning to meet the next is the loop this
      // check exists to prevent.
      if (o.lint === 'error') throw new Error(formatFindings(findings))
      console.warn(formatFindings(findings))
    }
  }

  // authoredDescriptions is scaffolding for the lint, not part of the public Tool.
  const tools: Tool[] = built.map(({ authoredDescriptions, ...tool }) => tool)
  // The group's text comes from the package, so the guide names the tools rather than
  // repeating the descriptions an agent already reads on each one.
  const editorSections: string[] = []
  for (const op of editorOps) {
    const group = await buildEditorTools(op, { doc, baseUrl, fetch: contextualFetch(fetchFn), locale: o.locale })
    tools.push(...group)
    editorSections.push(`## ${op.toolName}\n\nTools: ${group.map(t => t.name).join(', ')}`)
  }
  const instructions = [buildInstructions(doc, profiles, ops, o.locale), ...editorSections].filter(Boolean).join('\n\n')
  return { profiles, instructions, tools }
}
