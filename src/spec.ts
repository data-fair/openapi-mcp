import { validateVocabulary, type OperationFinding } from './vocabulary/validate.ts'
import { buildInput, assertFileResponseHeaders } from './input.ts'
import { resolveEditorOperations } from './editor/operations.ts'
import type { JsonSchema, AgentOperation, AgentOperationAnnotation, AgentParamOverride, AgentRoot, ResolvedBody, ResolvedOperation, ResolvedParam, SecurityRequirement } from './types.ts'

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

export function snakeCase (s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase()
}

/** Resolve a local JSON pointer like #/components/schemas/pet against the document. */
function pointer (doc: JsonSchema, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error(`external $ref not supported: ${ref}`)
  return ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~')).reduce<any>((acc, key) => {
    if (acc === undefined || acc === null) throw new Error(`unresolvable $ref: ${ref}`)
    return acc[key]
  }, doc)
}

/**
 * Inline every local $ref. A ref whose target is already an ancestor of the current node
 * (reached either by structural nesting or by a previous $ref on this branch) is a cycle and
 * becomes {}; the same ref reached twice on different branches is inlined twice (schemas are
 * small enough, and tools need self-contained schemas).
 */
export function inlineRefs (doc: JsonSchema): JsonSchema {
  const walk = (node: unknown, ancestors: object[]): unknown => {
    if (Array.isArray(node)) return node.map(n => walk(n, ancestors))
    if (!node || typeof node !== 'object') return node
    const obj = node as JsonSchema
    if (typeof obj.$ref === 'string') {
      const target = pointer(doc, obj.$ref)
      if (target && typeof target === 'object' && ancestors.includes(target as object)) return {}
      const { $ref, ...siblings } = obj
      const nextAncestors = target && typeof target === 'object' ? [...ancestors, target as object] : ancestors
      const resolved = walk(target, nextAncestors) as JsonSchema
      return { ...resolved, ...walk(siblings, ancestors) as JsonSchema }
    }
    const out: JsonSchema = {}
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v, [...ancestors, obj])
    return out
  }
  return walk(doc, []) as JsonSchema
}

export interface LoadSpecOptions {
  /**
   * What an operation whose x-agent this version rejects does. 'error' (the default) fails the
   * document. 'warn' and 'off' leave that operation's tools out and load the rest ('warn' says
   * which on the console): ignoring a key a server does not know could change a tool's meaning.
   * Findings outside one operation (root, tags, shared schemas) fail the document whatever the level.
   */
  lint?: 'error' | 'warn' | 'off'
}

export async function loadSpec (input: string | JsonSchema, fetchFn: typeof fetch, options: LoadSpecOptions = {}): Promise<JsonSchema> {
  let doc: JsonSchema
  if (typeof input === 'string') {
    const res = await fetchFn(input, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`failed to fetch OpenAPI document ${input}: HTTP ${res.status}`)
    doc = await res.json()
  } else {
    doc = input
  }
  if (typeof doc?.openapi !== 'string' || !doc.openapi.startsWith('3.')) throw new Error('only OpenAPI 3.x documents are supported')
  const lenient = options.lint === 'warn' || options.lint === 'off'
  const leftOut = new Map<string, { path: string, method: string, reasons: string[] }>()
  const onOperation = lenient
    ? ({ path, method, message }: OperationFinding) => {
        const key = `${method} ${path}`
        const entry = leftOut.get(key) ?? { path, method, reasons: [] }
        entry.reasons.push(message)
        leftOut.set(key, entry)
      }
    : undefined
  validateVocabulary(doc, onOperation)
  const inlined = inlineRefs(doc)
  checkAnnotations(inlined, onOperation, key => leftOut.has(key))
  // The annotation is what makes an operation a tool: without it the operation contributes none
  // of its views, and the document is otherwise untouched (inlined is a copy).
  const gone = new Set<string>()
  for (const { path, method } of leftOut.values()) {
    const op = inlined.paths[path][method]
    if (!op['x-agent']) continue // not a tool: nothing to strip from a skill, nothing of its own left out
    for (const view of Array.isArray(op['x-agent']) ? op['x-agent'] : [op['x-agent']]) {
      const name = view?.name ?? (typeof op.operationId === 'string' ? snakeCase(op.operationId) : undefined)
      if (name) gone.add(name)
    }
    delete op['x-agent']
  }
  // A skill must not publish the name of a tool this load left out.
  if (gone.size) for (const skill of (inlined['x-agent'] as AgentRoot | undefined)?.skills ?? []) if (skill.tools) skill.tools = skill.tools.filter(t => !gone.has(t))
  if (leftOut.size && options.lint === 'warn') {
    const lines = [...leftOut.values()].map(o => `  ${o.method.toUpperCase()} ${o.path}: ${o.reasons.join('; ')}`)
    console.warn(`openapi-mcp: ${leftOut.size} operation(s) left out of the tool set, their annotations are not accepted by this version:\n${lines.join('\n')}`)
  }
  return inlined
}

/** A requirement in a canonical form: schemes and their scopes sorted, so order never makes two differ. */
const canonical = (requirement: SecurityRequirement) => JSON.stringify(Object.keys(requirement).sort().map(k => [k, [...requirement[k]].sort()]))

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1')

const isJsonMedia = (t: string) => t === 'application/json' || /^application\/[^;]+\+json$/.test(t)
/** Media types that are not one file's bytes: JSON (sent as JSON, or not at all), forms, multipart. */
const notAFile = (t: string) => isJsonMedia(t) || t.startsWith('multipart/') || t === 'application/x-www-form-urlencoded'

/** The body a tool sends — see ResolvedBody. `+json` and form bodies are left out, as they always were. */
export function resolveBody (requestBody: any): ResolvedBody | undefined {
  const content: Record<string, any> = requestBody?.content ?? {}
  const required = requestBody?.required === true
  const json = content['application/json']
  if (json) return { kind: 'json', schema: json.schema ?? {}, required }
  const multipart = content['multipart/form-data']
  if (multipart) {
    const encoding: Record<string, string[]> = {}
    for (const [part, enc] of Object.entries<any>(multipart.encoding ?? {})) {
      if (typeof enc?.contentType === 'string') encoding[part] = enc.contentType.split(',').map((s: string) => s.trim()).filter(Boolean)
    }
    return { kind: 'multipart', schema: multipart.schema ?? {}, required, encoding }
  }
  const mediaTypes = Object.keys(content).filter(t => !notAFile(t))
  if (mediaTypes.length) return { kind: 'file', schema: {}, required, mediaTypes }
  return undefined
}

/**
 * Body annotations are checked on every view up front, so that a misspelled field fails at its
 * annotation (or, in a lenient load, leaves only that operation out). Needs the inlined document,
 * since a request body is usually a $ref.
 */
function checkAnnotations (doc: JsonSchema, onOperation?: (finding: OperationFinding) => void, alreadyLeftOut: (key: string) => boolean = () => false) {
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const annotation: AgentOperationAnnotation | undefined = item?.[method]?.['x-agent']
      if (annotation === undefined || alreadyLeftOut(`${method} ${path}`)) continue
      try {
        checkOperationAnnotation(path, method, item, annotation, doc, onOperation !== undefined)
      } catch (err: any) {
        if (!onOperation) throw err
        onOperation({ path, method, message: err.message })
      }
    }
  }
}

const isSecurity = (value: unknown): value is SecurityRequirement[] => Array.isArray(value) && value.every(requirement =>
  requirement !== null && typeof requirement === 'object' && !Array.isArray(requirement) &&
  Object.values(requirement).every(scopes => Array.isArray(scopes) && scopes.every(scope => typeof scope === 'string')))

/** Public: no alternative at all, or an empty one. */
const isPublic = (security: SecurityRequirement[]) => security.length === 0 || security.some(requirement => Object.keys(requirement).length === 0)

/**
 * The security a view's tool carries, checked: well formed (a filter reading it must never
 * throw), and an entry's own only narrowing the operation's. An alternative of the entry's own
 * would offer the tool to tokens the operation does not declare it accepts; an empty entry list
 * would make a secured operation's tool public.
 */
function checkSecurity (path: string, method: string, operation: any, view: AgentOperation, doc: JsonSchema, at: string) {
  const name = view.name ?? (typeof operation.operationId === 'string' ? snakeCase(operation.operationId) : at)
  const declared: unknown = operation.security ?? doc.security
  if (declared !== undefined && !isSecurity(declared)) {
    throw new Error(`${name}: the security of ${method.toUpperCase()} ${path} is not a list of requirements (scheme name → scope list)`)
  }
  if (view.security === undefined) return
  if (!isSecurity(view.security)) throw new Error(`x-agent invalid at ${at}: security must be a list of requirements (scheme name → scope list)`)
  // No security anywhere is not public: it fails closed, and an entry must not open it.
  if (view.security.length === 0 && !(declared !== undefined && isPublic(declared))) {
    throw new Error(`${name}: x-agent security [] makes the tool public, the operation's security is not`)
  }
  const known = new Set((declared ?? []).map(canonical))
  const added = view.security.find(alternative => !known.has(canonical(alternative)))
  if (added) throw new Error(`${name}: x-agent security alternative ${JSON.stringify(added)} is not in the operation's security`)
}

function checkOperationAnnotation (path: string, method: string, item: any, annotation: AgentOperationAnnotation, doc: JsonSchema, structural: boolean) {
  const operation = item[method]
  const body = resolveBody(operation.requestBody)
  const views = Array.isArray(annotation) ? annotation : [annotation]
  views.forEach((view, i) => {
    const at = `/paths/${esc(path)}/${method}${Array.isArray(annotation) ? `/${i}` : ''}`
    checkSecurity(path, method, operation, view, doc, at)
    if (view.body === 'compact' && body && body.kind !== 'json') {
      throw new Error(`x-agent invalid at ${at}: body: compact needs a JSON request body (this one is ${body.kind === 'multipart' ? 'multipart/form-data' : body.mediaTypes!.join(', ')})`)
    }
    if (!view.bodyFields && !view.bodyRequired) return
    const schema = body && body.kind !== 'file' ? body.schema : undefined
    if (schema?.type !== 'object' || !schema.properties) throw new Error(`x-agent invalid at ${at}: ${view.bodyFields ? 'bodyFields' : 'bodyRequired'} needs a JSON or multipart request body that is an object with properties`)
    if (view.bodyFields) {
      const missing = view.bodyFields.filter(f => !Object.hasOwn(schema.properties, f))
      if (missing.length) throw new Error(`x-agent invalid at ${at}: bodyFields names properties the request body does not declare: ${missing.join(', ')}`)
    }
    const offered = view.bodyFields ?? Object.keys(schema.properties)
    const stray = (view.bodyRequired ?? []).filter(f => !offered.includes(f))
    if (stray.length) throw new Error(`x-agent invalid at ${at}: bodyRequired names properties the tool does not offer: ${stray.join(', ')}`)
  })
  // What building the tools would refuse (selectParam, header parameters of a file response,
  // an editor's references), found here for every view so that a lenient load can leave the
  // operation out. A strict load keeps finding them when the tools are built, as it always did.
  if (!structural) return
  for (const agent of views) {
    if (!operation.operationId) throw new Error(`operation ${method.toUpperCase()} ${path} has x-agent but no operationId`)
    const op = resolveOne(path, item, method, operation, agent, doc.security)
    if (agent.editor) resolveEditorOperations(op, doc)
    else assertFileResponseHeaders(op, buildInput(op, 'en').bindings)
  }
}

/** Operation-level override wins over parameter-level x-agent. */
function mergeParam (raw: JsonSchema, override: AgentParamOverride | undefined): ResolvedParam {
  return {
    name: raw.name,
    in: raw.in,
    required: raw.required === true,
    schema: raw.schema ?? { type: 'string' },
    description: raw.description,
    style: raw.style,
    explode: raw.explode,
    agent: { ...(raw['x-agent'] ?? {}), ...(override ?? {}) }
  }
}

function resolveOne (path: string, item: any, method: string, op: any, agent: AgentOperation, rootSecurity: SecurityRequirement[] | undefined): ResolvedOperation {
  const tags: string[] = op.tags ?? []
  // path-level params first, operation-level override by (in, name)
  const rawParams = new Map<string, JsonSchema>()
  for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    if (!['path', 'query', 'header'].includes(p.in)) continue
    rawParams.set(`${p.in}:${p.name}`, p)
  }
  const params = [...rawParams.values()].map(p => mergeParam(p, agent.params?.[p.name]))

  const okCode = Object.keys(op.responses ?? {}).find(c => /^2\d\d$/.test(c))
  const okContent = okCode ? op.responses[okCode]?.content ?? {} : {}

  return {
    operationId: op.operationId,
    method: method.toUpperCase(),
    path,
    tags,
    summary: op.summary,
    description: op.description,
    params,
    requestBody: resolveBody(op.requestBody),
    responseSchema: okContent['application/json']?.schema,
    responseMediaTypes: Object.keys(okContent),
    // a copy: a caller adjusting a resolved operation must not edit the document's annotation
    agent: { ...agent },
    toolName: agent.name ?? snakeCase(op.operationId),
    security: agent.security ?? op.security ?? rootSecurity
  }
}

/** Every operation carrying `x-agent`, one entry per view. */
export function resolveOperations (doc: JsonSchema): ResolvedOperation[] {
  const out: ResolvedOperation[] = []
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op || op['x-agent'] === undefined) continue
      const annotation: AgentOperationAnnotation = op['x-agent']
      // Each view of an operation is a tool of its own.
      const views = Array.isArray(annotation) ? annotation : [annotation]
      views.forEach((agent, i) => {
        if (!op.operationId) throw new Error(`operation ${method.toUpperCase()} ${path} has x-agent but no operationId`)
        // Checked here too: a caller may resolve a document that never went through loadSpec.
        checkSecurity(path, method, op, agent, doc, `/paths/${esc(path)}/${method}${Array.isArray(annotation) ? `/${i}` : ''}`)
        out.push(resolveOne(path, item, method, op, agent, doc.security))
      })
    }
  }
  const dupes = out.map(o => o.toolName).filter((n, i, a) => a.indexOf(n) !== i)
  if (dupes.length) throw new Error(`duplicate tool names: ${[...new Set(dupes)].join(', ')}`)
  return out
}

/**
 * Resolve one operation by id with the x-agent gate lifted. An `editor`
 * annotation names operations that usually have no annotation of their own, so they are
 * invisible to resolveOperations.
 */
export function resolveOperationById (doc: JsonSchema, operationId: string): ResolvedOperation | undefined {
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method]
      if (op?.operationId !== operationId) continue
      // An editor reads or compiles the raw operation; views are tools, not data sources.
      const annotation: AgentOperationAnnotation | undefined = op['x-agent']
      const agent: AgentOperation = annotation && !Array.isArray(annotation) ? annotation : {}
      return resolveOne(path, item, method, op, agent, doc.security)
    }
  }
  return undefined
}
