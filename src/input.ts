import { localize } from './localize.ts'
import type { JsonSchema, ResolvedOperation, ResolvedParam } from './types.ts'

export interface Binding {
  toolName: string
  kind: 'path' | 'query' | 'header' | 'body' | 'bodyProp' | 'fields' | 'responseFormat'
  apiName: string
  style?: string
  explode?: boolean
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

export function buildInput (op: ResolvedOperation, locale: string): { inputSchema: JsonSchema, bindings: Binding[] } {
  const properties: JsonSchema = {}
  const required: string[] = []
  const bindings: Binding[] = []
  const fixed = op.agent.fixed ?? {}
  const selectParam = op.agent.response?.selectParam

  for (const p of op.params) {
    if (p.agent.exclude || p.name in fixed || p.name === selectParam) continue
    const toolName = p.agent.name ?? p.name
    properties[toolName] = paramSchema(p, locale)
    if (p.agent.required ?? p.required) required.push(toolName)
    bindings.push({ toolName, kind: p.in, apiName: p.name, style: p.style, explode: p.explode })
  }

  if (op.requestBody) {
    const body = op.requestBody.schema
    if (body.type === 'object' && body.properties) {
      for (const [name, schema] of Object.entries<any>(body.properties)) {
        const toolName = name in properties ? `${name}__body` : name
        properties[toolName] = schema
        if (body.required?.includes(name)) required.push(toolName)
        bindings.push({ toolName, kind: 'bodyProp', apiName: name, style: undefined, explode: undefined })
      }
    } else {
      properties.body = body
      if (op.requestBody.required) required.push('body')
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
    bindings.push({ toolName: 'fields', kind: 'fields', apiName: selectParam, style: apiParam.style ?? 'form', explode: apiParam.explode })
  }

  const { concise, detailed } = op.agent.response ?? {}
  if (concise && detailed) {
    const detailedText = detailed === true ? 'every field' : detailed.join(', ')
    properties.response_format = { type: 'string', enum: ['concise', 'detailed'], default: 'concise', description: `concise: ${concise.join(', ')}. detailed: ${detailedText}.` }
    bindings.push({ toolName: 'response_format', kind: 'responseFormat', apiName: 'response_format', style: undefined, explode: undefined })
  }

  const inputSchema: JsonSchema = { type: 'object', properties, additionalProperties: false }
  if (required.length) inputSchema.required = required
  return { inputSchema, bindings }
}
