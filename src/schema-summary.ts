/**
 * A JSON Schema as a compact listing an agent can read (`body: compact`): name, required, type,
 * allowed values and a short description per property, for a request body too large to put in a
 * tool definition. A reading aid only: the real schema still validates the body before sending.
 */
import type { JsonSchema } from './types.ts'

interface SummaryOptions {
  /** levels of nested objects listed before collapsing to `object` (default 0: nesting is what costs) */
  maxDepth?: number
  /** Descriptions longer than this are truncated; they are a hint, not the documentation. */
  maxDescription?: number
  /** Enums longer than this list their first values and then elide; some run to 18 members. */
  maxEnumValues?: number
}

/** `oneOf: [T, null]` is OpenAPI 3.1's "nullable T": listed as T, so its fields are not hidden. */
function unwrapNullable (schema: JsonSchema): { schema: JsonSchema, nullable: boolean } {
  const branches: JsonSchema[] | undefined = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(branches)) return { schema, nullable: false }
  const nonNull = branches.filter(b => b?.type !== 'null')
  if (nonNull.length === 1 && nonNull.length < branches.length) return { schema: nonNull[0], nullable: true }
  return { schema, nullable: false }
}

/** The object whose properties should be listed under this line, if any. */
function expandable (schema: JsonSchema): JsonSchema | undefined {
  if (schema.properties) return schema
  if (schema.type === 'array' && schema.items?.properties) return schema.items
  return undefined
}

function typeOf (schema: JsonSchema, maxEnumValues = 8): string {
  if (!schema || typeof schema !== 'object') return 'any'
  if (Array.isArray(schema.enum)) {
    const shown = schema.enum.slice(0, maxEnumValues).map((v: unknown) => JSON.stringify(v)).join('|')
    return schema.enum.length > maxEnumValues ? `${shown}|… (${schema.enum.length} values)` : shown
  }
  const branches: JsonSchema[] | undefined = schema.oneOf ?? schema.anyOf
  if (Array.isArray(branches)) return branches.map(b => typeOf(b, maxEnumValues)).join(' | ')
  if (schema.type === 'array') return `${typeOf(schema.items ?? {}, maxEnumValues)}[]`
  if (schema.type === 'object' || schema.properties) return 'object'
  if (Array.isArray(schema.type)) return schema.type.join('|')
  return schema.type ?? 'any'
}

function truncate (text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

function lines (schema: JsonSchema, depth: number, o: Required<SummaryOptions>): string[] {
  const properties = schema.properties
  if (!properties) return []
  const required = new Set<string>(schema.required ?? [])
  const out: string[] = []

  for (const [name, raw] of Object.entries<any>(properties)) {
    const { schema: inner, nullable } = unwrapNullable(raw)
    const indent = '  '.repeat(depth)
    const optional = required.has(name) ? '' : '?'
    const nested = expandable(inner)

    let type = typeOf(nested && inner.type === 'array' ? { type: 'array', items: { type: 'object' } } : (nested ? { type: 'object' } : inner), o.maxEnumValues)
    if (nullable) type += ' | null'

    const description = raw.description ?? inner.description
    const suffix = description ? ` — ${truncate(String(description), o.maxDescription)}` : ''
    out.push(`${indent}${name}${optional}: ${type}${suffix}`)

    if (nested && depth < o.maxDepth) out.push(...lines(nested, depth + 1, o))
  }
  return out
}

export function summariseSchema (schema: JsonSchema, options: SummaryOptions = {}): string {
  const o = { maxDepth: options.maxDepth ?? 0, maxDescription: options.maxDescription ?? 80, maxEnumValues: options.maxEnumValues ?? 8 }
  return lines(schema, 0, o).join('\n')
}
