import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv/dist/2020.js'
import { rootSchema, tagSchema, operationSchema, paramOverrideSchema, propertySchema } from './schema.ts'
import type { AgentOperation, JsonSchema } from '../types.ts'

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validators = {
  root: ajv.compile(rootSchema),
  tag: ajv.compile(tagSchema),
  operation: ajv.compile(operationSchema),
  param: ajv.compile(paramOverrideSchema),
  property: ajv.compile(propertySchema)
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

/** JSON pointer escaping for error paths */
const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1')

function check (kind: keyof typeof validators, value: unknown, path: string) {
  const validate = validators[kind]
  if (!validate(value)) {
    const msg = validate.errors!.map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`).join('; ')
    throw new Error(`x-agent invalid at ${path || '/'}: ${msg}`)
  }
}

/** Recursively validate x-agent on every schema property (response bodies, request bodies, parameter schemas). */
function checkSchema (schema: JsonSchema | undefined, path: string, seen = new Set<object>()) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return
  seen.add(schema)
  if (schema['x-agent'] !== undefined) check('property', schema['x-agent'], path)
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const map = schema[key]
    if (map && typeof map === 'object') for (const [k, v] of Object.entries(map)) checkSchema(v as JsonSchema, `${path}/${key}/${esc(k)}`, seen)
  }
  for (const key of ['items', 'additionalProperties', 'not']) if (schema[key] && typeof schema[key] === 'object') checkSchema(schema[key], `${path}/${key}`, seen)
  for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(schema[key])) schema[key].forEach((s: JsonSchema, i: number) => checkSchema(s, `${path}/${key}/${i}`, seen))
  }
}

function checkParams (params: any[] | undefined, path: string) {
  if (!Array.isArray(params)) return
  params.forEach((p, i) => {
    if (p?.['x-agent'] !== undefined) check('param', p['x-agent'], `${path}/${i}`)
    checkSchema(p?.schema, `${path}/${i}/schema`)
  })
}

const RENDERING = ['rows', 'concise', 'detailed', 'selectParam', 'hints'] as const

/**
 * An editor group edits the whole document its schema describes; it does not honour a body
 * allow-list, so accepting both would offer the fields the list exists to keep out. A file
 * response is a link the caller fetches: there is no request to send with a body, and nothing
 * is rendered.
 */
function checkView (view: unknown, path: string, method: string) {
  check('operation', view, path)
  const { editor, bodyFields, bodyRequired, response } = view as AgentOperation
  if (editor !== undefined && bodyFields) throw new Error(`x-agent invalid at ${path}: bodyFields does not apply to an editor group`)
  if (editor !== undefined && bodyRequired) throw new Error(`x-agent invalid at ${path}: bodyRequired does not apply to an editor group`)
  if (response?.file) {
    if (method !== 'get') throw new Error(`x-agent invalid at ${path}: response.file needs a GET operation: the tool returns a link to fetch, it sends no request`)
    const rendering = RENDERING.filter(k => response[k] !== undefined)
    if (rendering.length) throw new Error(`x-agent invalid at ${path}: response.file does not combine with ${rendering.join(', ')}: a file is not rendered`)
    if (editor !== undefined) throw new Error(`x-agent invalid at ${path}: response.file does not apply to an editor group`)
  }
}

/**
 * An operation annotation is one view or an array of views. Every view of an array is a tool
 * of its own, so each needs a name, unique within the array: the views of one PATCH are
 * selected together whenever a profile includes another, and a clash found only for some
 * profile sets would surface far from the annotation that caused it.
 */
function checkOperation (value: unknown, path: string, method: string) {
  if (!Array.isArray(value)) return checkView(value, path, method)
  if (!value.length) throw new Error(`x-agent invalid at ${path}: an array of views needs at least one view`)
  const names = new Set<string>()
  value.forEach((view, i) => {
    checkView(view, `${path}/${i}`, method)
    const name = (view as AgentOperation).name
    if (!name) throw new Error(`x-agent invalid at ${path}/${i}: every view of an operation needs a name`)
    if (names.has(name)) throw new Error(`x-agent invalid at ${path}/${i}: duplicate view name "${name}"`)
    names.add(name)
  })
}

/** A finding attributable to one operation's x-agent: what a lenient caller leaves out, rather than fail the document. */
export interface OperationFinding { path: string, method: string, message: string }

/**
 * Throws on the first invalid x-agent object found anywhere in the OpenAPI document.
 *
 * With `onOperation`, a finding attributable to ONE operation (its own x-agent, its own
 * parameters, the schemas of its own request and responses) is handed to the callback instead
 * and the scan goes on; everything else (root, tags, path-level parameters, shared components)
 * still throws. One implementation: the callback only decides what happens to the finding.
 */
export function validateVocabulary (doc: JsonSchema, onOperation?: (finding: OperationFinding) => void): void {
  if (doc['x-agent'] !== undefined) check('root', doc['x-agent'], '/')
  if (Array.isArray(doc.tags)) doc.tags.forEach((t: any, i: number) => { if (t?.['x-agent'] !== undefined) check('tag', t['x-agent'], `/tags/${i}`) })
  for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
    const itemPath = `/paths/${esc(p)}`
    checkParams(item?.parameters, `${itemPath}/parameters`)
    for (const m of METHODS) {
      const op = item?.[m]
      if (!op) continue
      const opPath = `${itemPath}/${m}`
      try {
        if (op['x-agent'] !== undefined) checkOperation(op['x-agent'], opPath, m)
        checkParams(op.parameters, `${opPath}/parameters`)
        for (const [mt, media] of Object.entries<any>(op.requestBody?.content ?? {})) checkSchema(media?.schema, `${opPath}/requestBody/content/${esc(mt)}/schema`)
        for (const [code, resp] of Object.entries<any>(op.responses ?? {})) {
          for (const [mt, media] of Object.entries<any>(resp?.content ?? {})) checkSchema(media?.schema, `${opPath}/responses/${code}/content/${esc(mt)}/schema`)
        }
      } catch (err: any) {
        if (!onOperation) throw err
        onOperation({ path: p, method: m, message: err.message })
      }
    }
  }
  for (const [name, schema] of Object.entries<any>(doc.components?.schemas ?? {})) checkSchema(schema, `/components/schemas/${esc(name)}`)
}
