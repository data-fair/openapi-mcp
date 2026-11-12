import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats'
import Debug from 'debug'
import { loadSpec, resolveOperations } from './spec.ts'
import { buildEditorTools } from './editor/index.ts'
import { buildInput } from './input.ts'
import { buildRequest } from './request.ts'
import { resolveLabels, addLabelInputs, checkLabels, type ResolvedLabel } from './labels.ts'
import { fileLink } from './file-link.ts'
import { render, projectResult, extract, omitProperty, type RenderOptions } from './render.ts'
import { localize } from './localize.ts'
import { callFetch, contextualFetch } from './context.ts'
import { resolveSkills, defaultSkillFetcher, editorSkill } from './skills.ts'
import { lintToolInput, formatFindings, type LintFinding } from './vocabulary/lint.ts'
import { createFileFetcher, openFiles, closeFiles, type FileFetcher, type FileLoadOptions } from './files.ts'
import type { FileSource } from './multipart.ts'
import type { Guide, JsonSchema, ResolvedOperation, Skill, SkillBodyFetcher, Tool, ToolResult, ToolSet, AgentRoot, AgentTag } from './types.ts'

const debug = Debug('openapi-mcp')
// ajv-formats is a CJS package whose module.exports is reassigned to a callable value; under
// NodeNext, TS types the default import as the whole (non-callable) module namespace rather
// than the callable value, so it needs a cast back to its declared type.
const addFormats = addFormatsModule as unknown as FormatsPlugin

export interface LoadOptions {
  fetch?: typeof fetch
  locale?: string
  baseUrl?: string
  /** the URL the document was fetched from, for relative skill links; set automatically when `spec` is a URL */
  documentUrl?: string
  /** how linked skill bodies are read, e.g. through a caller's cache; the default fetches with `fetch` */
  skillBodies?: SkillBodyFetcher
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
  /**
   * File inputs (indirect uploads): the file store's URL prefixes — none, and file inputs are off —
   * the size cap and the timeout. See docs/x-agent.md#files. A file URL is fetched without the
   * call context, never with its credentials.
   */
  files?: FileLoadOptions
  /** adapts an editor group's form schema (declared or fetched) before json-layout compiles it; default: as is */
  prepareEditorSchema?: (schema: JsonSchema) => JsonSchema | Promise<JsonSchema>
}

const ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults: true, coerceTypes: false })
addFormats(ajv)

/** The guides of the tags whose operations became tools, each with those tools. */
function buildGuides (doc: JsonSchema, toolsByOp: Map<ResolvedOperation, string[]>, locale: string): Guide[] {
  const guides: Guide[] = []
  for (const tag of doc.tags ?? []) {
    const agent: AgentTag | undefined = tag?.['x-agent']
    if (!agent?.guide) continue
    const tools = [...toolsByOp].filter(([op]) => op.tags.includes(tag.name)).flatMap(([, names]) => names)
    if (tools.length) guides.push({ name: tag.name, text: localize(agent.guide, locale)!.trim(), tools })
  }
  return guides
}

function errorsText (validate: ValidateFunction): string {
  return (validate.errors ?? []).map(e => `${e.instancePath || 'params'} ${e.message}`).join('; ')
}

type ToolOptions = Required<Omit<LoadOptions, 'documentUrl' | 'skillBodies' | 'files' | 'prepareEditorSchema'>> & { files: FileFetcher | undefined }

/** A fetch failure's message with its cause: undici reports a failed body stream as "fetch failed". */
const failureText = (err: any) => err?.cause?.message ? `${err.message} (${err.cause.message})` : (err?.message ?? String(err))

function makeTool (op: ResolvedOperation, o: ToolOptions, labels: ResolvedLabel[]): (Tool & { authoredDescriptions: Set<string> }) | undefined {
  const { inputSchema, bindings, authoredDescriptions, bodySchema, unavailable } = buildInput(op, o.locale, { files: o.files })
  if (unavailable) {
    debug('not offered: %s', unavailable)
    return undefined
  }
  // The label inputs are the tool's own: no binding, so they never reach the API.
  for (const name of addLabelInputs(inputSchema, labels, o.locale, op.toolName)) authoredDescriptions.add(name)
  const fileResponse = op.agent.response?.file === true
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
    outputSchema: o.structuredContent && !fileResponse ? [op.agent.response?.image, op.agent.response?.text].reduce((s, p) => p ? omitProperty(s, p) : s, op.responseSchema) : undefined,
    annotations: { readOnlyHint: op.method === 'GET' || op.method === 'HEAD', destructiveHint: op.method === 'DELETE', ...(op.agent.annotations ?? {}) },
    examples: op.agent.examples,
    security: op.security,
    async execute (rawParams, ctx): Promise<ToolResult> {
      const params = structuredClone(rawParams ?? {})
      if (!validate(params)) return { isError: true, text: `Invalid parameters: ${errorsText(validate)}` }
      if (validateBody && !validateBody(params.body)) {
        return { isError: true, text: `Invalid body: ${errorsText(validateBody)}` }
      }
      if (fileResponse) {
        try {
          return fileLink(op, bindings, params, o.baseUrl)
        } catch (err: any) {
          return { isError: true, text: `Request failed: ${err?.message ?? err}` }
        }
      }
      // Before anything is sent, files included: a label that is not its id's refuses the call.
      if (labels.length) {
        let refused: string | undefined
        try {
          refused = await checkLabels(labels, params, ctx, o.fetch, o.baseUrl)
        } catch (err: any) {
          return { isError: true, text: `Request failed while checking labels: ${failureText(err)}` }
        }
        if (refused) return { isError: true, text: refused }
      }
      // Every file is opened before the request: its Content-Length needs every size.
      let files: Record<string, FileSource>
      try {
        files = o.files ? await openFiles(bindings, params, o.files, ctx?.signal) : {}
      } catch (err: any) {
        return { isError: true, text: err?.message ?? String(err) }
      }
      let res: Response
      let body: string
      try {
        const req = buildRequest(op, bindings, params, o.baseUrl, files)
        debug('%s %s', req.method, req.url)
        res = await callFetch(req, ctx, o.fetch)
        // The body is read before the sources are released: closing one errors the request
        // body, and undici then terminates the response still arriving with it.
        body = await res.text()
      } catch (err: any) {
        return { isError: true, text: `Request failed: ${failureText(err)}` }
      } finally {
        // An upstream answering before it read the body (413, 401) does not cancel it: release
        // the sources so a large file is not streamed for nothing.
        closeFiles(files)
      }
      if (!res.ok) {
        const truncated = body.length > o.maxErrorLength ? body.slice(0, o.maxErrorLength) + '…' : body
        return { isError: true, text: `HTTP ${res.status}: ${truncated}` }
      }
      const contentType = res.headers.get('content-type') ?? ''
      if (!body.trim()) return { text: 'OK' }
      if (contentType.startsWith('application/json')) {
        let json: unknown
        try {
          json = JSON.parse(body)
        } catch (err: any) {
          return { isError: true, text: `Invalid JSON response: ${err?.message ?? err}` }
        }
        const renderOptions: RenderOptions = {
          schema: op.responseSchema,
          response: op.agent.response,
          fields: Array.isArray(params.fields) ? params.fields as string[] : undefined,
          responseFormat: params.response_format as 'concise' | 'detailed' | undefined,
          locale: o.locale,
          maxStringLength: o.maxStringLength
        }
        // The image and the verbatim text leave the body before rendering: neither is rendered nor structured.
        const { image: imagePointer, text: textPointer } = op.agent.response ?? {}
        let rest: unknown = json
        let image: ToolResult['image']
        let verbatim: string | undefined
        if (json && typeof json === 'object' && !Array.isArray(json)) {
          if (imagePointer) {
            const extracted = extract(json as Record<string, unknown>, imagePointer)
            rest = extracted.rest
            const found = extracted.found as any
            if (typeof found?.data === 'string' && typeof found?.mediaType === 'string') image = { data: found.data, mimeType: found.mediaType }
          }
          if (textPointer) {
            const extracted = extract(rest as Record<string, unknown>, textPointer)
            rest = extracted.rest
            if (typeof extracted.found === 'string') verbatim = extracted.found
          }
        }
        const text = verbatim ?? render(rest, renderOptions)
        return {
          text,
          ...(o.structuredContent ? { structuredContent: projectResult(rest, renderOptions) } : {}),
          ...(image ? { image } : {})
        }
      }
      return { text: body }
    }
  }
  return tool
}

export async function load (spec: string | JsonSchema, options: LoadOptions = {}): Promise<ToolSet> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const doc = await loadSpec(spec, fetchFn, { lint: options.lint })
  const root: AgentRoot = doc['x-agent'] ?? {}
  const baseUrl = options.baseUrl ?? doc.servers?.[0]?.url
  if (!baseUrl) throw new Error('no base URL: pass options.baseUrl or declare servers[0] in the document')
  const o = {
    fetch: fetchFn,
    locale: options.locale ?? 'en',
    baseUrl,
    structuredContent: options.structuredContent ?? false,
    maxStringLength: options.maxStringLength ?? 500,
    maxErrorLength: options.maxErrorLength ?? 4000,
    lint: options.lint ?? 'error',
    files: createFileFetcher(options.files)
  }
  const ops = resolveOperations(doc)
  const editorOps = ops.filter(op => op.agent.editor)
  const plainOps = ops.filter(op => !op.agent.editor)
  const toolsByOp = new Map<ResolvedOperation, string[]>()
  // A tool that cannot be built is a finding of its operation, like an invalid annotation.
  const failed = (op: ResolvedOperation, err: any) => {
    const message = `${op.toolName}: ${err?.message ?? err}`
    if (o.lint === 'error') throw new Error(message)
    if (o.lint === 'warn') console.warn(`openapi-mcp: ${op.method} ${op.path} left out of the tool set: ${message}`)
  }
  const built = plainOps.flatMap(op => {
    let tool: ReturnType<typeof makeTool>
    try {
      tool = makeTool(op, o, resolveLabels(op, doc))
    } catch (err) {
      failed(op, err)
    }
    if (tool) toolsByOp.set(op, [tool.name])
    return tool ?? []
  })

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
  // Each editor group publishes its json-layout fill-form skill.
  const editorSkills: Skill[] = []
  for (const op of editorOps) {
    let group: Awaited<ReturnType<typeof buildEditorTools>>
    try {
      group = await buildEditorTools(op, { doc, baseUrl, fetch: contextualFetch(fetchFn), locale: o.locale, prepareSchema: options.prepareEditorSchema ?? (schema => schema) })
    } catch (err) {
      failed(op, err)
      continue
    }
    tools.push(...group.tools)
    toolsByOp.set(op, group.tools.map(t => t.name))
    editorSkills.push(editorSkill(op, group.skill, group.tools.map(t => t.name), o.locale))
  }
  // Relative skill links resolve against the document's URL, else its server URL taken as a
  // directory: `…/api/v1` + `agents/skills/x.md` is `…/api/v1/agents/skills/x.md`.
  const skillBase = options.documentUrl ?? (typeof spec === 'string' ? spec : undefined) ?? baseUrl.replace(/\/?$/, '/')
  // A skill lists only the tools this load built, and one whose tools were all left out goes too.
  const names = new Set(tools.map(t => t.name))
  const rootSkills = (root.skills ?? []).flatMap(skill => {
    if (!skill.tools?.length) return [skill]
    const kept = skill.tools.filter(t => names.has(t))
    return kept.length ? [{ ...skill, tools: kept }] : []
  })
  const skills = [...await resolveSkills(rootSkills, o.locale, skillBase, options.skillBodies ?? defaultSkillFetcher(fetchFn)), ...editorSkills]
  return { tools, skills, guides: buildGuides(doc, toolsByOp, o.locale) }
}
