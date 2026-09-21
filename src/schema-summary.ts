/**
 * Renders a JSON Schema as a compact listing an agent can read.
 *
 * A write operation's request body can be very large: data-fair's `datasetPatch` is 26 KB
 * of schema across 216 properties, and merging it into a tool's input schema produced a
 * single tool twice the size of the whole six-tool explore set. Almost none of that weight
 * is information the agent needs to fill the form — it is `layout` keywords, prose, and
 * the structural noise of JSON Schema itself.
 *
 * The listing keeps what a caller actually needs: the property name, whether it is
 * required, its type, its allowed values, and a short description. Everything else goes.
 * Type-definition renderings of this kind are measured at roughly 60% smaller than the
 * JSON Schema they replace; dropping `layout` and full prose takes this one further.
 *
 * This is a reading aid, NOT the validation contract. The real schema still validates the
 * body before a request is sent, so a caller that misreads the listing gets a precise
 * local error rather than a round trip.
 */
import type { JsonSchema } from './types.ts'

export interface SummaryOptions {
  /**
   * How many levels of nested objects to expand before collapsing to `object`.
   *
   * Zero by default, on measurement: expanding one level of data-fair's `datasetPatch`
   * takes the listing from 35 lines to 114 and from 2.4 KB to 5.8 KB, while the properties
   * it reveals belong to sub-documents (`schema[]`, `masterData`) that a caller editing
   * them needs the real schema for anyway. Depth is the expensive knob; descriptions,
   * which cost about a third as much, are the useful one.
   */
  maxDepth?: number
  /** Descriptions longer than this are truncated; they are a hint, not the documentation. */
  maxDescription?: number
  /** Enums longer than this list their first values and then elide; some run to 18 members. */
  maxEnumValues?: number
}

/**
 * `oneOf: [T, null]` is how an OpenAPI 3.1 document spells "nullable T", and data-fair uses
 * it on nearly every property. Left alone it renders as `object | null` and hides the
 * branch that carries the actual fields, so the listing would say nothing at all.
 */
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
