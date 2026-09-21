import { validateVocabulary } from './vocabulary/validate.ts'
import type { JsonSchema, AgentOperation, AgentParamOverride, AgentRoot, AgentTag, ResolvedOperation, ResolvedParam } from './types.ts'

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

export function snakeCase (s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase()
}

export function defaultProfile (doc: JsonSchema): string {
  const root: AgentRoot = doc['x-agent'] ?? {}
  return Object.keys(root.profiles ?? {})[0] ?? 'default'
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

export async function loadSpec (input: string | JsonSchema, fetchFn: typeof fetch): Promise<JsonSchema> {
  let doc: JsonSchema
  if (typeof input === 'string') {
    const res = await fetchFn(input, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`failed to fetch OpenAPI document ${input}: HTTP ${res.status}`)
    doc = await res.json()
  } else {
    doc = input
  }
  if (typeof doc?.openapi !== 'string' || !doc.openapi.startsWith('3.')) throw new Error('only OpenAPI 3.x documents are supported')
  validateVocabulary(doc)
  return inlineRefs(doc)
}

function profilesInclude (profiles: string[] | true | undefined, profile: string): boolean {
  return profiles === true || (Array.isArray(profiles) && profiles.includes(profile))
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

function resolveOne (path: string, item: any, method: string, op: any, agent: AgentOperation, profiles: string[] | true, prefix: string): ResolvedOperation {
  const tags: string[] = op.tags ?? []
  // path-level params first, operation-level override by (in, name)
  const rawParams = new Map<string, JsonSchema>()
  for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    if (!['path', 'query', 'header'].includes(p.in)) continue
    rawParams.set(`${p.in}:${p.name}`, p)
  }
  const params = [...rawParams.values()].map(p => mergeParam(p, agent.params?.[p.name]))

  const bodyMedia = op.requestBody?.content?.['application/json']
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
    requestBody: bodyMedia ? { schema: bodyMedia.schema ?? {}, required: op.requestBody.required === true } : undefined,
    responseSchema: okContent['application/json']?.schema,
    responseMediaTypes: Object.keys(okContent),
    agent: { ...agent, profiles },
    toolName: prefix + (agent.name ?? snakeCase(op.operationId))
  }
}

export function resolveOperations (doc: JsonSchema, profile: string): ResolvedOperation[] {
  const root: AgentRoot = doc['x-agent'] ?? {}
  const prefix = root.namePrefix ?? ''
  const tagAgents = new Map<string, AgentTag>()
  for (const t of doc.tags ?? []) if (t?.['x-agent']) tagAgents.set(t.name, t['x-agent'])

  const out: ResolvedOperation[] = []
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op || op['x-agent'] === undefined) continue
      const agent: AgentOperation = op['x-agent']
      const tags: string[] = op.tags ?? []
      const tagProfiles = tags.map(t => tagAgents.get(t)?.profiles).find(p => p !== undefined)
      const profiles = agent.profiles ?? tagProfiles ?? true
      if (!profilesInclude(profiles, profile)) continue
      if (!op.operationId) throw new Error(`operation ${method.toUpperCase()} ${path} has x-agent but no operationId`)

      out.push(resolveOne(path, item, method, op, agent, profiles, prefix))
    }
  }
  const dupes = out.map(o => o.toolName).filter((n, i, a) => a.indexOf(n) !== i)
  if (dupes.length) throw new Error(`duplicate tool names: ${[...new Set(dupes)].join(', ')}`)
  return out
}

/**
 * Resolve one operation by id with the x-agent and profile gates lifted. An `editor`
 * annotation names operations that usually have no annotation of their own, so they are
 * invisible to resolveOperations.
 */
export function resolveOperationById (doc: JsonSchema, operationId: string): ResolvedOperation | undefined {
  const prefix = (doc['x-agent'] as AgentRoot | undefined)?.namePrefix ?? ''
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method]
      if (op?.operationId !== operationId) continue
      const agent: AgentOperation = op['x-agent'] ?? {}
      return resolveOne(path, item, method, op, agent, agent.profiles ?? true, prefix)
    }
  }
  return undefined
}
