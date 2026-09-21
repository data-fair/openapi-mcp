import { localize } from './localize.ts'
import { schemaAt, responseFields } from './input.ts'
import type { AgentResponse, JsonSchema } from './types.ts'

export interface RenderOptions {
  schema?: JsonSchema
  response?: AgentResponse
  fields?: string[]
  responseFormat?: 'concise' | 'detailed'
  locale: string
  maxStringLength?: number
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function projection (o: RenderOptions): string[] | undefined {
  if (o.fields?.length) return o.fields
  const r = o.response
  if (!r) return undefined
  if (o.responseFormat === 'detailed') return r.detailed === true ? undefined : r.detailed ?? undefined
  return r.concise
}

function truncate (s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function cell (v: unknown, max: number): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (Array.isArray(v)) s = v.map(x => isObject(x) ? JSON.stringify(x) : String(x)).join(', ')
  else if (isObject(v)) s = JSON.stringify(v)
  else s = String(v)
  return truncate(s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '), max)
}

function hintOf (schema: JsonSchema | undefined, locale: string): string | undefined {
  return localize(schema?.['x-agent']?.hint, locale)
}

/** Drop excluded properties (schema-driven) at every depth. */
function strip (value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema) return value
  if (Array.isArray(value)) return value.map(v => strip(v, schema.items))
  if (isObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const s = schema.properties?.[k]
      if (s?.['x-agent']?.exclude) continue
      out[k] = strip(v, s)
    }
    return out
  }
  return value
}

function table (rows: Record<string, unknown>[], schema: JsonSchema | undefined, columns: string[] | undefined, o: RenderOptions, max: number): string {
  if (!rows.length) return '_(no rows)_'
  const itemSchema = schema?.type === 'array' ? schema.items : schema
  const known = columns ?? (itemSchema ? responseFields(itemSchema) : [])
  const cols = [...known.filter(c => rows.some(r => c in r))]
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k)
  const lines = [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`]
  for (const r of rows) lines.push(`| ${cols.map(c => cell(r[c], max)).join(' | ')} |`)
  for (const c of cols) {
    const hint = hintOf(itemSchema?.properties?.[c], o.locale)
    if (hint) lines.push(`> ${c}: ${hint}`)
  }
  return lines.join('\n')
}

function kv (value: unknown, schema: JsonSchema | undefined, o: RenderOptions, max: number, indent: string): string[] {
  const lines: string[] = []
  if (!isObject(value)) return lines
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue
    const s = schema?.properties?.[k]
    const hint = hintOf(s, o.locale)
    const suffix = hint ? ` _(${hint})_` : ''
    if (isObject(v)) {
      lines.push(`${indent}- **${k}**:${suffix}`)
      lines.push(...kv(v, s, o, max, indent + '  '))
    } else if (Array.isArray(v) && v.some(isObject)) {
      lines.push(`${indent}- **${k}**:${suffix}`)
      for (const item of v) {
        if (isObject(item)) {
          lines.push(`${indent}  -`)
          lines.push(...kv(item, s?.items, o, max, indent + '    '))
        } else lines.push(`${indent}  - ${cell(item, max)}`)
      }
    } else {
      const text = k === 'next' && typeof v === 'string' ? v : cell(v, max)
      lines.push(`${indent}- **${k}**: ${text}${suffix}`)
    }
  }
  return lines
}

function project (row: Record<string, unknown>, keys: string[] | undefined): Record<string, unknown> {
  if (!keys) return row
  const out: Record<string, unknown> = {}
  for (const k of keys) if (k in row) out[k] = row[k]
  return out
}

export function render (body: unknown, o: RenderOptions): string {
  const max = o.maxStringLength ?? 500
  const keys = projection(o)
  const value = strip(body, o.schema)

  if (!isObject(value)) {
    if (Array.isArray(value)) {
      if (value.some(isObject)) return table(value.filter(isObject).map(r => project(r, keys)), o.schema, keys, o, max)
      return value.map(v => `- ${cell(v, max)}`).join('\n')
    }
    return value === null || value === undefined ? '' : truncate(String(value), max)
  }

  const rowsPointer = o.response?.rows
  const rowsKey = rowsPointer?.split('/').filter(Boolean)[0]
  const rows = rowsPointer ? rowsPointer.split('/').filter(Boolean).reduce<any>((acc, k) => acc?.[k], value) : undefined
  const hasRows = Array.isArray(rows)

  const rest: Record<string, unknown> = { ...value }
  if (hasRows && rowsKey) delete rest[rowsKey]
  if (o.response?.hints && isObject(rest.meta) && Array.isArray((rest.meta as any).hints)) {
    const meta = { ...(rest.meta as Record<string, unknown>) }
    delete meta.hints
    if (Object.keys(meta).length) rest.meta = meta; else delete rest.meta
  }

  const out: string[] = kv(hasRows ? rest : project(rest, keys), o.schema, o, max, '')
  if (hasRows) {
    if (out.length) out.push('')
    out.push(table((rows as unknown[]).filter(isObject).map(r => project(r, keys)), schemaAt(o.schema, rowsPointer), keys, o, max))
  }
  const hints = o.response?.hints ? (value as any).meta?.hints : undefined
  if (Array.isArray(hints) && hints.length) {
    out.push('')
    for (const h of hints) out.push(`> Hint: ${h}`)
  }
  return out.join('\n')
}
