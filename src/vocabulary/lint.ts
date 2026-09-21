/**
 * Checks that a description an annotation authored still agrees with the schema it
 * describes.
 *
 * An annotation may refine, name, exclude or describe a parameter. It may not contradict
 * it: `x-agent` rewrites the description and leaves the schema alone, so the two can drift
 * apart — and when they do, the model reads the description, does what it says, and Ajv
 * rejects it before any HTTP request is sent. Three such bugs shipped past review in phase
 * 1, all of the same shape: a description promising a scalar (`Example: "-count"`) for a
 * parameter whose schema is an array.
 *
 * Only descriptions an annotation AUTHORED are linted. An inherited description belongs to
 * the upstream document; it cannot be fixed from here, and linting it would bury a real
 * finding under prose we do not own.
 *
 * Every rule is mechanical. A rule that needs judgement does not belong here.
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
