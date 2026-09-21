import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats'
import Debug from 'debug'
import { loadSpec, resolveOperations, defaultProfile } from './spec.ts'
import { buildInput } from './input.ts'
import { buildRequest } from './request.ts'
import { render } from './render.ts'
import { localize } from './localize.ts'
import type { JsonSchema, ResolvedOperation, Tool, ToolResult, ToolSet, AgentRoot, AgentTag } from './types.ts'

const debug = Debug('openapi-mcp')
// ajv-formats is a CJS package whose module.exports is reassigned to a callable value; under
// NodeNext, TS types the default import as the whole (non-callable) module namespace rather
// than the callable value, so it needs a cast back to its declared type.
const addFormats = addFormatsModule as unknown as FormatsPlugin

export interface LoadOptions {
  profile?: string
  fetch?: typeof fetch
  locale?: string
  baseUrl?: string
  structuredContent?: boolean
  maxStringLength?: number
  maxErrorLength?: number
}

const ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults: true, coerceTypes: false })
addFormats(ajv)

export function buildInstructions (doc: JsonSchema, profile: string, ops: ResolvedOperation[], locale: string): string {
  const root: AgentRoot = doc['x-agent'] ?? {}
  const sections: string[] = []
  for (const skill of root.skills ?? []) {
    if (skill.profiles && !skill.profiles.includes(profile)) continue
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

function makeTool (op: ResolvedOperation, o: Required<Omit<LoadOptions, 'profile'>>): Tool {
  const { inputSchema, bindings } = buildInput(op, o.locale)
  const validate = ajv.compile(inputSchema)
  const description = (localize(op.agent.description, o.locale) ?? [op.summary, op.description].filter(Boolean).join('\n\n')).trim()
  const tool: Tool = {
    name: op.toolName,
    title: localize(op.agent.title, o.locale),
    description: description || op.operationId,
    inputSchema,
    outputSchema: o.structuredContent ? op.responseSchema : undefined,
    annotations: { readOnlyHint: op.method === 'GET' || op.method === 'HEAD', destructiveHint: op.method === 'DELETE', ...(op.agent.annotations ?? {}) },
    examples: op.agent.examples,
    async execute (rawParams): Promise<ToolResult> {
      const params = structuredClone(rawParams ?? {})
      if (!validate(params)) return { isError: true, text: `Invalid parameters: ${errorsText(validate)}` }
      let res: Response
      try {
        const req = buildRequest(op, bindings, params, o.baseUrl)
        debug('%s %s', req.method, req.url)
        res = await o.fetch(req)
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
  const profile = options.profile ?? defaultProfile(doc)
  const declared = Object.keys((doc['x-agent'] as AgentRoot | undefined)?.profiles ?? {})
  if (declared.length && !declared.includes(profile)) throw new Error(`unknown profile "${profile}" (declared: ${declared.join(', ')})`)
  const baseUrl = options.baseUrl ?? doc.servers?.[0]?.url
  if (!baseUrl) throw new Error('no base URL: pass options.baseUrl or declare servers[0] in the document')
  const o = {
    fetch: fetchFn,
    locale: options.locale ?? 'en',
    baseUrl,
    structuredContent: options.structuredContent ?? false,
    maxStringLength: options.maxStringLength ?? 500,
    maxErrorLength: options.maxErrorLength ?? 4000
  }
  const ops = resolveOperations(doc, profile)
  return { profile, instructions: buildInstructions(doc, profile, ops, o.locale), tools: ops.map(op => makeTool(op, o)) }
}
