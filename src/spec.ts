import { validateVocabulary, type OperationFinding } from './vocabulary/validate.ts'
import { responseFields } from './input.ts'
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

/** Follow a JSON pointer fragment ("/a/b", already without "#") inside a node; undefined when a step is missing. */
function follow (node: unknown, fragment: string): unknown {
  if (fragment === '') return node
  if (!fragment.startsWith('/')) return undefined // a plain-name anchor: not supported
  let acc: any = node
  for (const step of fragment.slice(1).split('/')) {
    const key = decodeURIComponent(step).replace(/~1/g, '/').replace(/~0/g, '~')
    if (acc === undefined || acc === null || typeof acc !== 'object' || !Object.hasOwn(acc, key)) return undefined
    acc = acc[key]
  }
  return acc
}

/**
 * Called for a $ref that cannot be resolved inside the document: it is replaced by {} (any value),
 * never a failure. A document assembled from several services must not lose every tool because
 * one schema points somewhere this library does not fetch.
 */
export type UnresolvedRef = (ref: string, at: string) => void

/**
 * Inline every $ref the document can resolve itself.
 *
 * - `#/…` resolves against the nearest enclosing schema resource (a schema with a string `$id`),
 *   as JSON Schema says, and against the document root when that resource does not have it
 *   (OpenAPI's `#/components/…` from inside an embedded resource).
 * - `<uri>#/…` resolves when some schema of the document declares `$id: <uri>` (absolute, or relative
 *   to the enclosing resource's `$id`).
 * - Anything else (a file or URL the document does not embed, a missing target, an anchor) becomes
 *   {} and is reported to `onUnresolved`. Except under a `security` list, where {} would be the
 *   public alternative: there the $ref stays as written, so the security check refuses it.
 *
 * A ref whose target is already an ancestor of the current node (reached either by structural
 * nesting or by a previous $ref on this branch) is a cycle and becomes {}; the same ref reached
 * twice on different branches is inlined twice (schemas are small enough, and tools need
 * self-contained schemas).
 */
/** A root, operation or x-agent entry `security` list, or anything inside one. */
const underSecurity = (at: string) => /^(\/paths\/[^/]+\/[^/]+(\/x-agent(\/\d+)?)?)?\/security(\/|$)/.test(at)

export function inlineRefs (doc: JsonSchema, onUnresolved: UnresolvedRef = () => {}): JsonSchema {
  // Every embedded schema resource (a schema with a string $id) by its absolute id, and the
  // resource each node belongs to. Ids are recorded as resources are met, so a relative $id is
  // read against its parent's absolute one.
  const ids = new WeakMap<object, string>()
  const byId = new Map<string, object>()
  const resourceOf = new WeakMap<object, object>()
  const absoluteId = (id: string, base: string | undefined) => {
    let out = id
    try { out = new URL(id, base).href } catch { /* not a URL, or no base: kept as written */ }
    return out.replace(/#$/, '')
  }
  const index = (node: unknown, resource: object) => {
    if (!node || typeof node !== 'object' || resourceOf.has(node)) return
    const obj = node as JsonSchema
    if (!Array.isArray(obj) && obj !== doc && typeof obj.$id === 'string') {
      const id = absoluteId(obj.$id, ids.get(resource))
      ids.set(obj, id)
      if (!byId.has(id)) byId.set(id, obj)
      resource = obj
    }
    resourceOf.set(obj, resource)
    for (const v of Object.values(obj)) index(v, resource)
  }
  index(doc, doc)

  const resolve = (ref: string, resource: object): unknown => {
    const hash = ref.indexOf('#')
    const uri = hash === -1 ? ref : ref.slice(0, hash)
    const fragment = hash === -1 ? '' : ref.slice(hash + 1)
    if (uri === '') {
      const local = resource !== doc ? follow(resource, fragment) : undefined
      return local !== undefined ? local : follow(doc, fragment)
    }
    const target = byId.get(absoluteId(uri, ids.get(resource)))
    return target === undefined ? undefined : follow(target, fragment)
  }

  const walk = (node: unknown, ancestors: object[], resource: object, at: string): unknown => {
    if (Array.isArray(node)) return node.map((n, i) => walk(n, ancestors, resource, `${at}/${i}`))
    if (!node || typeof node !== 'object') return node
    const obj = node as JsonSchema
    if (ids.has(obj)) resource = obj
    if (typeof obj.$ref === 'string') {
      const { $ref, ...siblings } = obj
      const target = resolve($ref, resource)
      if (target === undefined) {
        onUnresolved($ref, at)
        if (underSecurity(at)) return obj
        return walk(siblings, ancestors, resource, at)
      }
      if (target && typeof target === 'object' && ancestors.includes(target as object)) return {}
      const nextAncestors = target && typeof target === 'object' ? [...ancestors, target as object] : ancestors
      const targetResource = target && typeof target === 'object' ? (resourceOf.get(target as object) ?? doc) : resource
      const resolved = walk(target, nextAncestors, targetResource, at) as JsonSchema
      return { ...resolved, ...walk(siblings, ancestors, resource, at) as JsonSchema }
    }
    const out: JsonSchema = {}
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v, [...ancestors, obj], resource, `${at}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`)
    return out
  }
  return walk(doc, [], doc, '') as JsonSchema
}

export interface LoadSpecOptions {
  /**
   * What an operation whose x-agent this version rejects does. 'error' (the default) fails the
   * document. 'warn' and 'off' leave that operation's tools out and load the rest ('warn' says
   * which on the console): ignoring a key a server does not know could change a tool's meaning.
   * Findings outside one operation (root, tags, shared schemas, duplicate tool names) fail the
   * document whatever the level. A $ref the document cannot resolve itself never fails it: it
   * reads as {} (see inlineRefs), and is listed on the console unless 'off'.
   */
  lint?: 'error' | 'warn' | 'off'
}

/**
 * The document, fetched when given a URL, its refs inlined and every annotation checked: what
 * building the tools relies on. An operation a lenient load leaves out loses its x-agent, and a
 * skill stops listing its tools.
 */
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
  const unresolved: string[] = []
  const inlined = inlineRefs(doc, (ref, at) => { unresolved.push(`  ${at}: ${ref}`) })
  if (unresolved.length && options.lint !== 'off') {
    console.warn(`openapi-mcp: ${unresolved.length} $ref(s) the document does not resolve itself, read as {} (any value), or refused under security:\n${unresolved.join('\n')}`)
  }
  for (const { path, item, method } of annotatedOperations(inlined)) {
    if (leftOut.has(`${method} ${path}`)) continue
    try {
      checkOperation(path, item, method, inlined)
    } catch (err: any) {
      if (!onOperation) throw err
      onOperation({ path, method, message: err.message })
    }
  }
  // The annotation is what makes an operation a tool: without it the operation contributes none
  // of its views, and the document is otherwise untouched (inlined is a copy).
  const gone = new Set<string>()
  for (const { path, method } of leftOut.values()) {
    const op = inlined.paths[path][method]
    if (!op['x-agent']) continue // not a tool: nothing to strip from a skill, nothing of its own left out
    for (const view of views(op['x-agent'])) {
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
  const names = annotatedOperations(inlined).flatMap(({ item, method }) => views(item[method]['x-agent']).map(view => view.name ?? snakeCase(item[method].operationId)))
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  if (dupes.length) throw new Error(`duplicate tool names: ${[...new Set(dupes)].join(', ')}`)
  return inlined
}

const views = (annotation: AgentOperationAnnotation): AgentOperation[] => Array.isArray(annotation) ? annotation : [annotation]

/** Every operation carrying x-agent, in document order. */
function annotatedOperations (doc: JsonSchema): { path: string, item: any, method: string }[] {
  const out: { path: string, item: any, method: string }[] = []
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) if (item?.[method]?.['x-agent'] !== undefined) out.push({ path, item, method })
  }
  return out
}

/** A requirement in a canonical form: schemes and their scopes sorted, so order never makes two differ. */
const canonical = (requirement: SecurityRequirement) => JSON.stringify(Object.keys(requirement).sort().map(k => [k, [...requirement[k]].sort()]))

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1')

const isJsonMedia = (t: string) => t === 'application/json' || /^application\/[^;]+\+json$/.test(t)
/** Media types that are not one file's bytes: JSON (sent as JSON, or not at all), forms, multipart. */
const notAFile = (t: string) => isJsonMedia(t) || t.startsWith('multipart/') || t === 'application/x-www-form-urlencoded'

/** The body a tool sends — see ResolvedBody. `+json` and form bodies are left out. */
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
function checkSecurity (op: ResolvedOperation, declared: unknown, view: AgentOperation, at: string) {
  if (declared !== undefined && !isSecurity(declared)) {
    throw new Error(`${op.toolName}: the security of ${op.method} ${op.path} is not a list of requirements (scheme name → scope list)`)
  }
  if (view.security === undefined) return
  if (!isSecurity(view.security)) throw new Error(`x-agent invalid at ${at}: security must be a list of requirements (scheme name → scope list)`)
  // No security anywhere is not public: it fails closed, and an entry must not open it.
  if (view.security.length === 0 && !(declared !== undefined && isPublic(declared))) {
    throw new Error(`${op.toolName}: x-agent security [] makes the tool public, the operation's security is not`)
  }
  const known = new Set((declared ?? []).map(canonical))
  const added = view.security.find(alternative => !known.has(canonical(alternative)))
  if (added) throw new Error(`${op.toolName}: x-agent security alternative ${JSON.stringify(added)} is not in the operation's security`)
}

function checkBody (op: ResolvedOperation, view: AgentOperation, at: string) {
  const body = op.requestBody
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
}

function checkResponse (op: ResolvedOperation) {
  const { selectParam, rows, file } = op.agent.response ?? {}
  if (selectParam) {
    if (!op.params.some(p => p.name === selectParam)) throw new Error(`${op.toolName}: response.selectParam "${selectParam}" is not a parameter`)
    if (!responseFields(op.responseSchema, rows).length) throw new Error(`${op.toolName}: response.selectParam "${selectParam}" needs response fields, but the response schema declares no properties (at ${rows ? `"${rows}"` : 'the top level'})`)
  }
  if (file) {
    // A file response is a link the caller fetches: it cannot carry a header.
    const headers = op.params.filter(p => p.in === 'header' && !p.agent.exclude && !(p.name in (op.agent.fixed ?? {}))).map(p => p.name)
    if (headers.length) throw new Error(`${op.toolName}: response.file returns a link, which cannot carry header parameters (${headers.join(', ')}); exclude them`)
  }
}

/** Every check of one operation's annotation that the vocabulary schemas cannot express. */
function checkOperation (path: string, item: any, method: string, doc: JsonSchema) {
  const operation = item[method]
  if (!operation.operationId) throw new Error(`operation ${method.toUpperCase()} ${path} has x-agent but no operationId`)
  const annotation: AgentOperationAnnotation = operation['x-agent']
  views(annotation).forEach((view, i) => {
    const at = `/paths/${esc(path)}/${method}${Array.isArray(annotation) ? `/${i}` : ''}`
    const op = resolveOne(path, item, method, operation, view, doc.security)
    checkSecurity(op, operation.security ?? doc.security, view, at)
    if (view.editor) {
      resolveEditorOperations(op, doc)
      return
    }
    checkBody(op, view, at)
    checkResponse(op)
  })
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

/** Every operation carrying `x-agent`, one entry per view, from a document loadSpec checked. */
export function resolveOperations (doc: JsonSchema): ResolvedOperation[] {
  return annotatedOperations(doc).flatMap(({ path, item, method }) =>
    views(item[method]['x-agent']).map(view => resolveOne(path, item, method, item[method], view, doc.security)))
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
