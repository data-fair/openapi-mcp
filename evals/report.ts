#!/usr/bin/env node
/**
 * Summarise a judged run.
 *
 * Deliberately has almost no thresholds: the numbers are context and the verdict is the
 * judge's. The one criterion that IS reported against a number is the spec's B/A token
 * ratio — and even that only prints "over", because it is the project's question, not a
 * test that should fail a command.
 *
 * What does fail the report: a run that never dispatched, a transcript nobody judged, and
 * a transcript that failed in the harness itself. That last one is kept visually and
 * numerically distinct from "not judged": a harness failure (network, MCP subprocess
 * crash) happens before any tool is ever exercised, so scoring it like a tool failure
 * would bias the B/A comparison this harness exists to produce — arm A hits a live
 * rate-limited public instance, arm B a local fixture server, and those have structurally
 * different chances of throwing for reasons that have nothing to do with tool quality. It
 * still fails the report (an incomplete run is not a passing run), just in its own bucket.
 *
 * Token totals are dominated by cache: one measured transcript spent 58,610 of its 60,925
 * tokens on cache (read + creation) against 2,315 input+output. Because arm B's tool
 * definitions are larger than arm A's, B carries a structurally higher cache cost
 * regardless of how well its tools actually work. So alongside the spec's headline
 * total-token ratio, input+output is broken out on its own clearly-labelled line, with its
 * own B/A ratio — never merged into or confused with the headline.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Transcript } from './transcript.ts'
import type { Verdict } from './verdict.ts'

export interface Run { scenario: string, arm: 'A' | 'B', transcript: Transcript | null, verdict: Verdict | null }
// instructionsBytes is optional: the committed baseline's tool-definitions.json predates
// it and is never rewritten (its numbers were measured after that run, not part of it).
export interface ToolDefs {
  A?: { toolNames: string[], definitionBytes: number, instructionsBytes?: number }
  B?: { toolNames: string[], definitionBytes: number, instructionsBytes?: number }
}

const TOKEN_RATIO_CRITERION = 1.2

function truncateError (msg: string, max = 100): string {
  const oneLine = msg.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine
}

export function summarise (runs: Run[], toolDefs: ToolDefs | null): { lines: string[], failed: boolean } {
  const lines: string[] = []
  let failed = false

  lines.push('| scenario | arm | verdict | calls | errors | friction | tokens | cost |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')

  for (const run of [...runs].sort((a, b) => a.scenario.localeCompare(b.scenario) || a.arm.localeCompare(b.arm))) {
    if (!run.transcript) {
      failed = true
      lines.push(`| ${run.scenario} | ${run.arm} | **never ran** | - | - | - | - | - |`)
      continue
    }
    const m = run.transcript.metrics
    if (run.transcript.isError) {
      // The harness itself failed before any tool call was usable — there is nothing here
      // for the judge to assess and nothing for the "not judged" bucket to mean either.
      // Keyed on `isError`, not `error`: a run can fail this way without having thrown (the
      // SDK's own `is_error` on the result, or no result message at all), and `error` is
      // only ever set on the thrown path — see `evals/transcript.ts`'s doc comment.
      failed = true
      const detail = run.transcript.error ?? 'no result message (is_error, or the stream ended with no result)'
      lines.push(`| ${run.scenario} | ${run.arm} | **harness error**: ${truncateError(detail)} | ${m.toolCalls} | ${m.toolErrors} | - | ${m.totalTokens} | $${m.costUsd.toFixed(4)} |`)
      continue
    }
    if (!run.verdict) {
      failed = true
      lines.push(`| ${run.scenario} | ${run.arm} | **not judged** | ${m.toolCalls} | ${m.toolErrors} | - | ${m.totalTokens} | $${m.costUsd.toFixed(4)} |`)
      continue
    }
    const mark = run.verdict.verdict === 'satisfactory' ? 'pass' : '**fail**'
    lines.push(`| ${run.scenario} | ${run.arm} | ${mark} | ${m.toolCalls} | ${m.toolErrors} | ${run.verdict.friction.length} | ${m.totalTokens} | $${m.costUsd.toFixed(4)} |`)
  }

  const neverRan = runs.filter(r => !r.transcript).length
  const harnessErrors = runs.filter(r => r.transcript?.isError).length
  const notJudged = runs.filter(r => r.transcript && !r.transcript.isError && !r.verdict).length
  lines.push('')
  lines.push(`never ran: ${neverRan}, not judged: ${notJudged}, harness errors: ${harnessErrors}`)

  const byArm = (arm: 'A' | 'B') => runs.filter(r => r.arm === arm)
  const tokens = (arm: 'A' | 'B') => byArm(arm).reduce((n, r) => n + (r.transcript?.metrics.totalTokens ?? 0), 0)
  const ioTokens = (arm: 'A' | 'B') => byArm(arm).reduce((n, r) => n + (r.transcript ? r.transcript.metrics.inputTokens + r.transcript.metrics.outputTokens : 0), 0)
  const friction = (arm: 'A' | 'B') => byArm(arm).reduce((n, r) => n + (r.verdict?.friction.length ?? 0), 0)
  const passes = (arm: 'A' | 'B') => byArm(arm).filter(r => r.verdict?.verdict === 'satisfactory').length

  lines.push('')
  for (const arm of ['A', 'B'] as const) {
    if (byArm(arm).length) lines.push(`arm ${arm}: ${passes(arm)}/${byArm(arm).length} satisfactory, ${tokens(arm)} tokens`)
  }
  lines.push(`friction points: A ${friction('A')}, B ${friction('B')}`)

  const ta = tokens('A'); const tb = tokens('B')
  if (ta > 0 && tb > 0) {
    const ratio = tb / ta
    lines.push(`B/A token ratio: ${ratio.toFixed(2)} (criterion: ≤ ${TOKEN_RATIO_CRITERION}${ratio > TOKEN_RATIO_CRITERION ? ' — over' : ''})`)
  }

  // Cache can dwarf input+output (a measured transcript was 58,610/60,925 cache) and B's
  // larger tool definitions give it a structurally higher cache cost independent of tool
  // quality — so this line never gets folded into the headline ratio above.
  const ioA = ioTokens('A'); const ioB = ioTokens('B')
  if (ioA > 0 && ioB > 0) {
    const ioRatio = ioB / ioA
    lines.push(`B/A input+output token ratio (excludes cache; headline above includes it): ${ioRatio.toFixed(2)} — input+output tokens: A ${ioA}, B ${ioB}`)
  }

  if (toolDefs?.A || toolDefs?.B) {
    // instructionsBytes is sent through the protocol on every run just like the tool
    // definitions, and the design doc counts it as part of the same static preamble — so it
    // is reported alongside definitionBytes, not left out of the comparison (a pre-F5
    // tool-definitions.json, like the committed baseline's, simply omits it here).
    const size = (arm: 'A' | 'B') => {
      const d = toolDefs?.[arm]
      if (!d) return 'not measured'
      if (d.instructionsBytes == null) return `${d.toolNames.length} tools, ${d.definitionBytes} bytes`
      return `${d.toolNames.length} tools, ${d.definitionBytes} bytes definitions + ${d.instructionsBytes} bytes instructions = ${d.definitionBytes + d.instructionsBytes} bytes`
    }
    lines.push(`tool definitions: A ${size('A')}; B ${size('B')}`)
  }

  return { lines, failed }
}

/**
 * Adds a `transcript: null` row for every (scenario, arm) pair in `scenarios` × `arms` that
 * `existing` has no run for — so a scenario with no transcript file at all (never dispatched,
 * or lost when a batch died partway through) still gets a row `summarise` renders as "never
 * ran", instead of just not appearing. Pure and independent of the filesystem, so it is
 * testable without a runs directory: the CLI below is the only caller that touches disk.
 */
export function fillMissingRuns (scenarios: { id: string }[], existing: Run[], arms: ('A' | 'B')[]): Run[] {
  const byKey = new Map(existing.map(r => [`${r.scenario}--${r.arm}`, r]))
  for (const s of scenarios) {
    for (const arm of arms) {
      const key = `${s.id}--${arm}`
      if (!byKey.has(key)) byKey.set(key, { scenario: s.id, arm, transcript: null, verdict: null })
    }
  }
  return Array.from(byKey.values())
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const here = fileURLToPath(new URL('.', import.meta.url))
  const RUNS_DIR = join(here, 'runs')
  if (!existsSync(RUNS_DIR)) throw new Error(`no runs directory at ${RUNS_DIR} — run eval:run first`)

  // A transcript or verdict file that fails to parse (most plausibly a maintainer
  // interrupting a batch mid-write, leaving one truncated JSON file) must make the one run
  // it belongs to unreadable, not make the whole report command throw and disappear.
  function readJsonSafe<T> (path: string): T | null {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (err: any) {
      console.error(`could not read ${path} — ${err?.message ?? err}`)
      return null
    }
  }

  const defsPath = join(RUNS_DIR, 'tool-definitions.json')
  const toolDefs: ToolDefs | null = existsSync(defsPath) ? readJsonSafe<ToolDefs>(defsPath) : null

  const files = readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('.verdict.json') && f !== 'tool-definitions.json')

  const armsSeen = new Set<'A' | 'B'>()
  const existing: Run[] = files.map(file => {
    const transcript = readJsonSafe<Transcript>(join(RUNS_DIR, file))
    // Prefer the parsed transcript's own scenario/arm; fall back to the filename (which
    // encodes both) when the file failed to parse, so a corrupt transcript still produces
    // exactly one row — rendered "never ran" by summarise via transcript: null — instead of
    // silently vanishing.
    const [scenarioFromName, armFromName] = file.replace(/\.json$/, '').split('--')
    const scenario = transcript?.scenario ?? scenarioFromName
    const arm = (transcript?.arm ?? armFromName) as 'A' | 'B'
    armsSeen.add(arm)
    const verdictPath = join(RUNS_DIR, file.replace(/\.json$/, '.verdict.json'))
    const verdict = existsSync(verdictPath) ? readJsonSafe<Verdict>(verdictPath) : null
    return { scenario, arm, transcript, verdict }
  })

  // "The arms present" for filling in missing rows: tool-definitions.json is written once
  // per eval:run invocation for exactly the arms that invocation covered (respecting
  // --arm), so it is the authoritative source when present. Fall back to whatever arms
  // actually show up in the runs directory only when it is missing.
  const presentArms: ('A' | 'B')[] = toolDefs
    ? (['A', 'B'] as const).filter(a => toolDefs[a])
    : Array.from(armsSeen)

  const scenarios: { id: string }[] = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'))
  const runs: Run[] = fillMissingRuns(scenarios, existing, presentArms)

  const { lines, failed } = summarise(runs, toolDefs)
  console.log(lines.join('\n'))
  if (failed) process.exit(1)
}
