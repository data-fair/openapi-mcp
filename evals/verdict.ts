/**
 * Parse and validate a judge's verdict.
 *
 * The judge is a language model, so its answer is untrusted text. Validating here means a
 * malformed verdict fails loudly at parse time rather than silently producing an empty
 * friction list that reads as "no problems found".
 */

export interface FrictionPoint {
  call: number
  tool: string
  observed: string
  inferred: string
  severity: 'high' | 'medium' | 'low'
}

export interface Verdict {
  scenario: string
  verdict: 'satisfactory' | 'unsatisfactory'
  reasoning: string
  friction: FrictionPoint[]
}

const VERDICTS = ['satisfactory', 'unsatisfactory']
const SEVERITIES = ['high', 'medium', 'low']

export function parseVerdict (text: string): Verdict {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const raw = (fenced ? fenced[1] : text).trim()

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`the judge's answer could not be parsed as JSON: ${raw.slice(0, 200)}`)
  }

  if (typeof parsed?.scenario !== 'string') throw new Error('verdict.scenario must be the scenario id')
  if (!VERDICTS.includes(parsed.verdict)) {
    throw new Error(`verdict must be one of ${VERDICTS.join(', ')}, got ${JSON.stringify(parsed.verdict)}`)
  }
  if (typeof parsed.reasoning !== 'string' || !parsed.reasoning.trim()) {
    throw new Error('verdict.reasoning must explain the verdict')
  }
  if (!Array.isArray(parsed.friction)) throw new Error('verdict.friction must be an array')

  for (const [i, point] of parsed.friction.entries()) {
    // Anchoring is what makes a friction point actionable: without a call number nobody
    // can find the response that misled the agent. 1-based, so 0 is rejected too.
    if (!Number.isInteger(point?.call) || point.call < 1) {
      throw new Error(`friction[${i}].call must be the 1-based call number`)
    }
    if (typeof point.tool !== 'string') throw new Error(`friction[${i}].tool must name the tool`)
    if (typeof point.observed !== 'string') throw new Error(`friction[${i}].observed must quote what the tool returned`)
    if (typeof point.inferred !== 'string') throw new Error(`friction[${i}].inferred must say what the agent apparently concluded`)
    if (!SEVERITIES.includes(point.severity)) {
      throw new Error(`friction[${i}].severity must be one of ${SEVERITIES.join(', ')}`)
    }
  }

  return parsed as Verdict
}
