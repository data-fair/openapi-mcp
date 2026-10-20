/**
 * Checks that a description an annotation authored agrees with the schema it describes: the
 * model follows the description, and the schema refuses what disagrees before any request.
 * Inherited descriptions belong to the upstream document and are not linted. Every rule is
 * mechanical.
 */
import type { JsonSchema } from '../types.ts'

export interface LintFinding {
  tool: string
  param: string
  rule: 'scalar-example-for-array' | 'comma-separated-array' | 'quoted-value-not-in-enum'
  message: string
}

/** Double- or single-quoted runs, which is how descriptions carry examples and values. */
const QUOTED = /["']([^"'\n]{1,60})["']/g

const COMMA_SEPARATED = /comma[-\s]separated/i

const isArray = (schema: JsonSchema): boolean =>
  schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'))

/** An array-shaped example (`["-count"]`) is the correct way to show an array's value. */
const hasArrayLiteral = (description: string): boolean => /\[\s*["']/.test(description)

function quotedValues (description: string): string[] {
  return [...description.matchAll(QUOTED)].map(m => m[1])
}

export function lintToolInput (tool: string, inputSchema: JsonSchema, authored: Set<string>): LintFinding[] {
  const findings: LintFinding[] = []

  for (const [param, schema] of Object.entries<any>(inputSchema.properties ?? {})) {
    if (!authored.has(param)) continue
    const description: string = schema?.description ?? ''
    if (!description) continue

    if (isArray(schema)) {
      if (quotedValues(description).length && !hasArrayLiteral(description)) {
        findings.push({
          tool,
          param,
          rule: 'scalar-example-for-array',
          message: 'description shows a quoted scalar example but the parameter is an array — show an array, e.g. ["value"]'
        })
      }
      if (COMMA_SEPARATED.test(description)) {
        findings.push({
          tool,
          param,
          rule: 'comma-separated-array',
          message: 'description says "comma-separated" but the parameter is an array — the commas are added when the request is serialized, and the agent never sees them'
        })
      }
    }

    // An enum on the parameter, or on an array's items, is the only case where a quoted
    // value can be checked against something. Without one there is nothing to contradict.
    const values: unknown[] | undefined = schema.enum ?? schema.items?.enum
    if (Array.isArray(values)) {
      const allowed = new Set(values.map(String))
      const strays = quotedValues(description).filter(v => !allowed.has(v))
      if (strays.length) {
        findings.push({
          tool,
          param,
          rule: 'quoted-value-not-in-enum',
          message: `description quotes ${strays.map(v => JSON.stringify(v)).join(', ')}, which the parameter's enum does not allow (${[...allowed].join(', ')})`
        })
      }
    }
  }

  return findings
}

/** One multi-line message naming every finding, so a fix-and-rerun loop is not needed. */
export function formatFindings (findings: LintFinding[]): string {
  const lines = findings.map(f => `  ${f.tool}.${f.param} [${f.rule}]: ${f.message}`)
  return `annotation lint found ${findings.length} description/schema disagreement${findings.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
}
