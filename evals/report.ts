#!/usr/bin/env node
/**
 * Summarise a judged run, and compare it with a baseline run when one is given:
 * `node evals/report.ts [baselineDir]`.
 *
 * The numbers are context and the verdicts are the judge's: the report fails only on an
 * incomplete run (a scenario that never ran, a transcript nobody judged, or a run that failed in
 * the harness, which is kept apart from "not judged": nothing of the tools was exercised).
 *
 * Token totals are dominated by cache, which grows with the size of the tool definitions, so
 * input+output tokens get their own figure.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Transcript } from './transcript.ts'
import type { Verdict } from './verdict.ts'

export interface Run { scenario: string, transcript: Transcript | null, verdict: Verdict | null }
export interface ToolDefs { toolNames: string[], definitionBytes: number, instructionsBytes?: number }
export interface RunSet { runs: Run[], toolDefs: ToolDefs | null }

function truncateError (msg: string, max = 100): string {
  const oneLine = msg.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}

const tokens = (runs: Run[]) => runs.reduce((n, r) => n + (r.transcript?.metrics.totalTokens ?? 0), 0)
const ioTokens = (runs: Run[]) => runs.reduce((n, r) => n + (r.transcript ? r.transcript.metrics.inputTokens + r.transcript.metrics.outputTokens : 0), 0)
const friction = (runs: Run[]) => runs.reduce((n, r) => n + (r.verdict?.friction.length ?? 0), 0)
const passes = (runs: Run[]) => runs.filter(r => r.verdict?.verdict === 'satisfactory').length
const size = (d: ToolDefs) => d.instructionsBytes == null
  ? `${d.toolNames.length} tools, ${d.definitionBytes} bytes`
  : `${d.toolNames.length} tools, ${d.definitionBytes} bytes definitions + ${d.instructionsBytes} bytes instructions`

export function summarise (current: RunSet, baseline?: RunSet): { lines: string[], failed: boolean } {
  const { runs, toolDefs } = current
  const lines: string[] = []
  let failed = false
  const before = new Map(baseline?.runs.map(r => [r.scenario, r.verdict?.verdict]))

  lines.push('| scenario | verdict | calls | errors | friction | tokens | cost |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const run of [...runs].sort((a, b) => a.scenario.localeCompare(b.scenario))) {
    if (!run.transcript) {
      failed = true
      lines.push(`| ${run.scenario} | **never ran** | - | - | - | - | - |`)
      continue
    }
    const m = run.transcript.metrics
    if (run.transcript.isError) {
      failed = true
      const detail = run.transcript.error ?? 'no result message (is_error, or the stream ended with no result)'
      lines.push(`| ${run.scenario} | **harness error**: ${truncateError(detail)} | ${m.toolCalls} | ${m.toolErrors} | - | ${m.totalTokens} | $${m.costUsd.toFixed(4)} |`)
      continue
    }
    if (!run.verdict) {
      failed = true
      lines.push(`| ${run.scenario} | **not judged** | ${m.toolCalls} | ${m.toolErrors} | - | ${m.totalTokens} | $${m.costUsd.toFixed(4)} |`)
      continue
    }
    let mark = run.verdict.verdict === 'satisfactory' ? 'pass' : '**fail**'
    const was = before.get(run.scenario)
    if (was && was !== run.verdict.verdict) mark += ` (was ${was === 'satisfactory' ? 'pass' : 'fail'})`
    lines.push(`| ${run.scenario} | ${mark} | ${m.toolCalls} | ${m.toolErrors} | ${run.verdict.friction.length} | ${m.totalTokens} | $${m.costUsd.toFixed(4)} |`)
  }

  lines.push('')
  lines.push(`never ran: ${runs.filter(r => !r.transcript).length}, not judged: ${runs.filter(r => r.transcript && !r.transcript.isError && !r.verdict).length}, harness errors: ${runs.filter(r => r.transcript?.isError).length}`)
  lines.push(`${passes(runs)}/${runs.length} satisfactory, ${friction(runs)} friction points, ${tokens(runs)} tokens (input+output ${ioTokens(runs)})`)
  if (toolDefs) lines.push(`tool definitions: ${size(toolDefs)}`)

  if (baseline) {
    const b = baseline.runs
    lines.push('')
    lines.push(`baseline: ${passes(b)}/${b.length} satisfactory, ${friction(b)} friction points, ${tokens(b)} tokens (input+output ${ioTokens(b)})`)
    if (baseline.toolDefs) lines.push(`baseline tool definitions: ${size(baseline.toolDefs)}`)
    if (tokens(b) > 0 && tokens(runs) > 0) lines.push(`token ratio to baseline: ${(tokens(runs) / tokens(b)).toFixed(2)} (input+output ${(ioTokens(runs) / ioTokens(b)).toFixed(2)})`)
  }
  return { lines, failed }
}

/** A `transcript: null` row for every scenario without a run, so it is reported as never ran. */
export function fillMissingRuns (scenarios: { id: string }[], existing: Run[]): Run[] {
  const byScenario = new Map(existing.map(r => [r.scenario, r]))
  for (const s of scenarios) if (!byScenario.has(s.id)) byScenario.set(s.id, { scenario: s.id, transcript: null, verdict: null })
  return Array.from(byScenario.values())
}

/** A file that does not parse (a batch interrupted mid-write) loses its own run, not the report. */
function readJsonSafe<T> (path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err: any) {
    console.error(`could not read ${path}: ${err?.message ?? err}`)
    return null
  }
}

/** The transcripts, verdicts and tool definitions of a run directory. */
export function readRunSet (dir: string): RunSet {
  if (!existsSync(dir)) throw new Error(`no run directory at ${dir}`)
  const defsPath = join(dir, 'tool-definitions.json')
  const toolDefs = existsSync(defsPath) ? readJsonSafe<ToolDefs>(defsPath) : null
  const runs = readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.verdict.json') && f !== 'tool-definitions.json')
    .map(file => {
      const transcript = readJsonSafe<Transcript>(join(dir, file))
      const verdictPath = join(dir, file.replace(/\.json$/, '.verdict.json'))
      return { scenario: transcript?.scenario ?? file.replace(/\.json$/, ''), transcript, verdict: existsSync(verdictPath) ? readJsonSafe<Verdict>(verdictPath) : null }
    })
  return { runs, toolDefs }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const current = readRunSet(join(here, 'runs'))
  const scenarios: { id: string }[] = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'))
  current.runs = fillMissingRuns(scenarios, current.runs)
  const baselineDir = process.argv[2]
  const { lines, failed } = summarise(current, baselineDir ? readRunSet(baselineDir) : undefined)
  console.log(lines.join('\n'))
  if (failed) process.exit(1)
}
