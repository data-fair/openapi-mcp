import { localize } from './localize.ts'
import { summariseSchema } from './schema-summary.ts'
import type { JsonSchema, ResolvedOperation, ResolvedParam } from './types.ts'

export interface Binding {
  toolName: string
  kind: 'path' | 'query' | 'header' | 'body' | 'bodyProp' | 'fields' | 'responseFormat' | 'file'
  /** API name; for a raw file body, 'body' */
  apiName: string
  style?: string
  explode?: boolean
  /** file: the media types the API accepts for it, when it declares specific ones */
  accept?: string[]
}

/** Walk a JSON pointer inside a schema: "/results" → schema.properties.results; array steps go through items. */
export function schemaAt (schema: JsonSchema | undefined, pointer: string | undefined): JsonSchema | undefined {
  if (!schema) return undefined
  if (!pointer) return schema
  let node: JsonSchema | undefined = schema
  for (const key of pointer.split('/').filter(Boolean)) {
    node = node?.properties?.[key]
    if (!node) return undefined
  }
  return node
}

/** Keys of the rows item schema (when rows is set) or of the response object, excluding x-agent.exclude ones. */
export function responseFields (schema: JsonSchema | undefined, rows?: string): string[] {
  let node = schemaAt(schema, rows)
  if (node?.type === 'array') node = node.items
  return Object.entries<any>(node?.properties ?? {}).filter(([, s]) => !s?.['x-agent']?.exclude).map(([k]) => k)
}

function paramSchema (p: ResolvedParam, locale: string): JsonSchema {
  const schema: JsonSchema = { ...p.schema }
  // The raw OpenAPI title (often untranslated, e.g. French) has no agent-facing override and
  // would otherwise sit next to a rewritten description in a different language; descriptions
  // already carry the agent-facing text, so the inherited title is dropped rather than shown.
  delete schema.title
  const description = localize(p.agent.description, locale) ?? p.description
  if (description) schema.description = description.trim()
  // default/maximum describe a single value; on an array-typed param (data-fair's
  // explode:false comma-joined params, e.g. one size entry per aggregation level) that
  // value belongs on items, not on the array itself. A default/maximum sitting on the
  // array made ajv's useDefaults fill a scalar into an array-typed property and then
  // reject it — both when the API document declares it directly (e.g. search_data's raw
  // `select` param: `{ type: array, items: { type: string }, default: "all" }`, which
  // broke every call that omitted `select`) and when an agent.params override adds one
  // (aggregate_data's former agg_size override, which broke every call outright). Both
  // sources are normalized onto items here.
  if (schema.type === 'array') {
    const items: JsonSchema = { ...schema.items }
    if (schema.default !== undefined) { items.default = schema.default; delete schema.default }
    if (schema.maximum !== undefined) { items.maximum = schema.maximum; delete schema.maximum }
    if (p.agent.default !== undefined) items.default = p.agent.default
    if (p.agent.maximum !== undefined) items.maximum = p.agent.maximum
    // enum, like default/maximum, describes a single value: it must constrain each array
    // item, not the array itself. Applying it to the array's own schema (alongside
    // items: { type: 'string' }) produces a shape ajv rejects for every value, since no
    // array literal can equal one of the enum's scalar members.
    if (p.agent.enum !== undefined) items.enum = p.agent.enum
    schema.items = items
  } else {
    if (p.agent.default !== undefined) schema.default = p.agent.default
    if (p.agent.maximum !== undefined) schema.maximum = p.agent.maximum
    if (p.agent.enum !== undefined) schema.enum = p.agent.enum
  }
  return schema
}

/**
 * A view's body as its tool sends it: reduced to `bodyFields` when the view has an allow-list,
 * and with `bodyRequired` added to what is required. Applied before the flat/compact choice so
 * the flat properties, the compact listing and the local validation agree;
 * `additionalProperties: false` keeps a compact body from carrying a field the view does not
 * offer. With an allow-list, composition keywords of the original schema are dropped on
 * purpose: an allow-list that a `oneOf` could widen again would not be one.
 */
function pickBody (op: ResolvedOperation): ResolvedOperation['requestBody'] {
  const { bodyFields: fields, bodyRequired } = op.agent
  if (!op.requestBody || (!fields && !bodyRequired)) return op.requestBody
  const schema = op.requestBody.schema
  if (schema.type !== 'object' || !schema.properties) throw new Error(`${op.toolName}: ${fields ? 'bodyFields' : 'bodyRequired'} needs an object request body with properties`)
  const missing = (fields ?? []).filter(f => !Object.hasOwn(schema.properties, f))
  if (missing.length) throw new Error(`${op.toolName}: bodyFields names properties the request body does not declare: ${missing.join(', ')}`)
  const offered = fields ?? Object.keys(schema.properties)
  const stray = (bodyRequired ?? []).filter(f => !offered.includes(f))
  if (stray.length) throw new Error(`${op.toolName}: bodyRequired names properties the tool does not offer: ${stray.join(', ')}`)
  const picked: JsonSchema = fields
    ? { type: 'object', properties: Object.fromEntries(fields.map(f => [f, schema.properties[f]])), additionalProperties: false }
    : { ...schema }
  if (fields && schema.description) picked.description = schema.description
  const required = [...new Set([...(schema.required ?? []).filter((r: string) => offered.includes(r)), ...(bodyRequired ?? [])])]
  if (required.length) picked.required = required
  else delete picked.required
  return { ...op.requestBody, schema: picked }
}

/**
 * A multipart part that carries a file: `format: binary` (OpenAPI 3.0) or a `contentMediaType`
 * (OpenAPI 3.1, JSON Schema 2020-12 §8.4) without a `contentEncoding`, which would make it
 * inline encoded text rather than a file.
 */
export function isFilePart (schema: JsonSchema | undefined): boolean {
  return !!schema && (schema.format === 'binary' || (typeof schema.contentMediaType === 'string' && schema.contentEncoding === undefined))
}

export const FILE_NOTE = 'URL of the file to send, from the file store this server is configured for: the server downloads it and names it after the last path segment, extension included.'

/** File inputs are on: the size cap to publish. Absent: no file store is configured. */
export interface FileInputs {
  maxSize: number
}

/** application/octet-stream says nothing about what is accepted, so it is not published. */
const specificTypes = (types: string[]): string[] | undefined => {
  const specific = types.filter(t => t !== 'application/octet-stream')
  return specific.length ? specific : undefined
}

/**
 * A file input: a URL the server fetches, marked with `x-mcp-file` (the keyword of the MCP
 * file-input proposals SEP-2356 / SEP-2631). Not `contentMediaType`, which would say the string
 * IS the bytes.
 */
function fileProperty (description: string | undefined, accept: string[] | undefined, maxSize: number): JsonSchema {
  const marker: JsonSchema = {}
  if (accept) marker.accept = accept
  marker.maxSize = maxSize
  return { type: 'string', format: 'uri', description: description ? `${description.trim()}\n\n${FILE_NOTE}` : FILE_NOTE, 'x-mcp-file': marker }
}

/** A file response is a link the caller fetches: it cannot carry the header parameters a request would. */
export function assertFileResponseHeaders (op: ResolvedOperation, bindings: Binding[]): void {
  const headerParams = bindings.filter(b => b.kind === 'header').map(b => b.apiName)
  if (op.agent.response?.file === true && headerParams.length) throw new Error(`${op.toolName}: response.file returns a link, which cannot carry header parameters (${headerParams.join(', ')}); exclude them`)
}

export function buildInput (op: ResolvedOperation, locale: string, options: { files?: FileInputs } = {}): { inputSchema: JsonSchema, bindings: Binding[], authoredDescriptions: Set<string>, bodySchema?: JsonSchema, unavailable?: string } {
  const properties: JsonSchema = {}
  const required: string[] = []
  const bindings: Binding[] = []
  // Properties whose description this project wrote — an x-agent override, or one of the
  // generated params below. Only these are linted: an inherited description belongs to the
  // upstream document and cannot be fixed from here.
  const authoredDescriptions = new Set<string>()
  // Set when the tool cannot be offered: it needs a file that cannot be sent. load leaves it out.
  let unavailable: string | undefined
  const filesOff = (name: string) => `${op.toolName}: needs a file ("${name}"), and file inputs are off (no files.urlPrefixes configured)`
  const fixed = op.agent.fixed ?? {}
  const selectParam = op.agent.response?.selectParam

  for (const p of op.params) {
    if (p.agent.exclude || p.name in fixed || p.name === selectParam) continue
    const toolName = p.agent.name ?? p.name
    properties[toolName] = paramSchema(p, locale)
    if (localize(p.agent.description, locale)) authoredDescriptions.add(toolName)
    if (p.agent.required ?? p.required) required.push(toolName)
    bindings.push({ toolName, kind: p.in, apiName: p.name, style: p.style, explode: p.explode })
  }

  const requestBody = pickBody(op)
  // In compact mode the body is one property described by a listing, and the real schema
  // is returned for the caller to validate against — a tool definition carrying data-fair's
  // 28 KB dataset body costs more than the entire six-tool explore set.
  let bodySchema: JsonSchema | undefined
  if (requestBody?.kind === 'json' && op.agent.body === 'compact') {
    properties.body = {
      type: 'object',
      description: `The request body. Properties (\`?\` marks optional):\n\n${summariseSchema(requestBody.schema)}`
    }
    if (requestBody.required) required.push('body')
    bindings.push({ toolName: 'body', kind: 'body', apiName: 'body', style: undefined, explode: undefined })
    authoredDescriptions.add('body')
    bodySchema = requestBody.schema
  } else if (requestBody?.kind === 'file') {
    // A raw body is the bytes of one file: one input, named after what it is.
    const toolName = 'file' in properties ? 'file__body' : 'file'
    if (!options.files) {
      if (requestBody.required) unavailable = filesOff(toolName)
    } else {
      const accept = specificTypes(requestBody.mediaTypes ?? [])
      properties[toolName] = fileProperty(undefined, accept, options.files.maxSize)
      if (requestBody.required) required.push(toolName)
      bindings.push({ toolName, kind: 'file', apiName: 'body', accept })
    }
  } else if (requestBody) {
    const body = requestBody.schema
    if (body.type === 'object' && body.properties) {
      for (const [name, schema] of Object.entries<any>(body.properties)) {
        const toolName = name in properties ? `${name}__body` : name
        const isRequired = body.required?.includes(name) === true
        if (requestBody.kind === 'multipart' && isFilePart(schema)) {
          if (!options.files) {
            // No file store: an optional file part is not offered, a required one makes the tool unavailable.
            if (isRequired) unavailable ??= filesOff(name)
            continue
          }
          const accept = specificTypes(requestBody.encoding?.[name] ?? (typeof schema.contentMediaType === 'string' ? [schema.contentMediaType] : []))
          properties[toolName] = fileProperty(schema.description, accept, options.files.maxSize)
          bindings.push({ toolName, kind: 'file', apiName: name, accept })
        } else if (requestBody.kind === 'multipart' && schema?.type === 'array' && isFilePart(schema.items)) {
          // A tool input carries one URL per part: a list of files is not offered, and a tool needing one is not either.
          if (isRequired) unavailable ??= `${op.toolName}: multipart part "${name}" is a list of files, which a tool cannot send (one URL per part)`
          continue
        } else {
          properties[toolName] = schema
          bindings.push({ toolName, kind: 'bodyProp', apiName: name, style: undefined, explode: undefined })
        }
        if (isRequired) required.push(toolName)
      }
    } else if (requestBody.kind === 'json') {
      properties.body = body
      if (requestBody.required) required.push('body')
      bindings.push({ toolName: 'body', kind: 'body', apiName: 'body', style: undefined, explode: undefined })
    }
  }

  if (selectParam) {
    const apiParam = op.params.find(p => p.name === selectParam)
    if (!apiParam) throw new Error(`${op.operationId}: response.selectParam "${selectParam}" is not a parameter`)
    const fields = responseFields(op.responseSchema, op.agent.response?.rows)
    if (!fields.length) throw new Error(`${op.operationId}: response.selectParam "${selectParam}" needs response fields, but the response schema declares no properties (at${op.agent.response?.rows ? ` "${op.agent.response.rows}"` : ' the top level'})`)
    properties.fields = {
      type: 'array',
      items: { type: 'string', enum: fields },
      description: 'Response fields to return (default: the concise set). Use to fetch exactly what you need.'
    }
    authoredDescriptions.add('fields')
    bindings.push({ toolName: 'fields', kind: 'fields', apiName: selectParam, style: apiParam.style ?? 'form', explode: apiParam.explode })
  }

  const { concise, detailed } = op.agent.response ?? {}
  if (concise && detailed) {
    const detailedText = detailed === true ? 'every field' : detailed.join(', ')
    properties.response_format = { type: 'string', enum: ['concise', 'detailed'], default: 'concise', description: `concise: ${concise.join(', ')}. detailed: ${detailedText}.` }
    authoredDescriptions.add('response_format')
    bindings.push({ toolName: 'response_format', kind: 'responseFormat', apiName: 'response_format', style: undefined, explode: undefined })
  }

  const inputSchema: JsonSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length) inputSchema.required = required
  return { inputSchema, bindings, authoredDescriptions, bodySchema, unavailable }
}
