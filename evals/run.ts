#!/usr/bin/env node
/**
 * Runs each scenario against each arm and writes one transcript per run.
 *
 * `allowedTools` is not optional. Without it every MCP tool call is DENIED, and the agent
 * — which cannot tell a denial from a broken tool — answers that it has a permissions
 * problem. That run looks like a failure of the tools under test and is a failure of the
 * harness. Verified by probe before this harness was written.
 *
 * Sequential by default: 22 runs against one rate-limited public instance, where a 429
 * lands as a tool error and corrupts exactly the comparison being made.
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { isolationOptions, neutralCwd } from './isolation.ts'
import { armA, armB, discoverTools, type ArmSpec } from './arms.ts'
import { startFixtureServer } from './fixture-server.ts'
import { extractCalls, extractMetrics, extractResolvedModels, type Transcript } from './transcript.ts'

const PORTAL_URL = process.env.PORTAL_URL ?? 'https://opendata.koumoul.com'
const MODEL = process.env.OPENAPI_MCP_EVAL_MODEL ?? 'haiku'
const here = fileURLToPath(new URL('.', import.meta.url))
const RUNS_DIR = join(here, 'runs')

interface Scenario { id: string, question: string, expected: string }

function parseArgs (argv: string[]) {
  const ids: string[] = []
  let arm: 'A' | 'B' | undefined
  let concurrency = 1
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--arm') {
      const raw = argv[++i]
      if (raw !== 'A' && raw !== 'B') throw new Error(`--arm must be A or B, got ${JSON.stringify(raw)}`)
      arm = raw
    } else if (argv[i] === '--concurrency') {
      const raw = argv[++i]
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1) throw new Error(`--concurrency must be a positive integer, got ${JSON.stringify(raw)}`)
      concurrency = n
    } else ids.push(argv[i])
  }
  return { ids, arm, concurrency }
}

/**
 * A run that throws (creating the neutral cwd, the query() call itself — network failure,
 * MCP subprocess crash, auth error — cleanup, or extracting the transcript) is recorded as
 * a datum, never left to crash the batch: the try/catch below covers the whole body,
 * including cwd creation, so every throw path in a run is caught the same way.
 */
async function runOne (scenario: Scenario, arm: ArmSpec, allowedTools: string[]): Promise<Transcript> {
  const startedAt = new Date().toISOString()
  let cwd: string | undefined
  try {
    const messages: any[] = []
    let result: any = null
    try {
      cwd = neutralCwd()
      for await (const message of query({
        prompt: scenario.question,
        options: {
          ...isolationOptions(cwd),
          model: MODEL,
          allowedTools,
          mcpServers: { [arm.serverName]: arm.config }
        }
      })) {
        messages.push(message)
        if (message.type === 'result') result = message
      }
    } finally {
      if (cwd) rmSync(cwd, { recursive: true, force: true })
    }

    const calls = extractCalls(messages)
    return {
      scenario: scenario.id,
      arm: arm.name,
      model: MODEL,
      resolvedModels: extractResolvedModels(result),
      startedAt,
      provenance: arm.provenance,
      question: scenario.question,
      calls,
      answer: result?.result ?? '',
      isError: result?.is_error === true || result == null,
      metrics: extractMetrics(result, calls)
    }
  } catch (err: any) {
    return {
      scenario: scenario.id,
      arm: arm.name,
      model: MODEL,
      resolvedModels: [],
      startedAt,
      provenance: arm.provenance,
      question: scenario.question,
      calls: [],
      answer: '',
      isError: true,
      error: err?.message ?? String(err),
      metrics: extractMetrics(null, [])
    }
  }
}

/**
 * Writes one transcript to disk, never throwing: `runOne` above cannot throw (see its own
 * doc comment), which made this write the last unguarded statement left in the batch loop —
 * a failure here (full disk, permissions) would otherwise reject `pool()`'s `Promise.all`
 * and take every still-queued run down with it. Exported so the guard itself — not the
 * SDK-driven `runOne` — is what a test exercises.
 */
export function writeTranscriptSafely (path: string, transcript: Transcript, label: string): void {
  try {
    writeFileSync(path, JSON.stringify(transcript, null, 2) + '\n')
  } catch (err: any) {
    console.error(`${label}: failed to write transcript file — ${err?.message ?? err}`)
  }
}

/** Runs tasks with a bounded number in flight, preserving input order in the results. */
async function pool<T> (tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }))
  return results
}

// Gated behind the same CLI-entrypoint check judge.ts and report.ts already use: it keeps
// `node --test` free to import the pure pieces above (writeTranscriptSafely, runOne, pool)
// without side-effecting a live fixture server, subprocess spawns and network calls just by
// loading this module.
async function main () {
  const { ids, arm: onlyArm, concurrency } = parseArgs(process.argv.slice(2))
  const all: Scenario[] = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'))
  const scenarios = ids.length ? all.filter(s => ids.includes(s.id)) : all
  if (!scenarios.length) throw new Error(`no scenarios matched ${ids.join(', ')}`)

  mkdirSync(RUNS_DIR, { recursive: true })
  const fixture = await startFixtureServer()
  try {
    const arms: ArmSpec[] = []
    if (onlyArm !== 'B') arms.push(armA(PORTAL_URL))
    if (onlyArm !== 'A') arms.push(armB(fixture.url, fixture.hash))

    const discovered: Record<string, { toolNames: string[], definitionBytes: number, instructionsBytes: number }> = {}
    const allowed: Record<string, string[]> = {}
    for (const a of arms) {
      const d = await discoverTools(a)
      discovered[a.name] = { toolNames: d.toolNames, definitionBytes: d.definitionBytes, instructionsBytes: d.instructionsBytes }
      allowed[a.name] = d.allowedTools
      console.log(`arm ${a.name}: ${d.toolNames.length} tools, ${d.definitionBytes} bytes of definitions, ${d.instructionsBytes} bytes of instructions`)
    }
    writeFileSync(join(RUNS_DIR, 'tool-definitions.json'),
      JSON.stringify({ ...discovered, measuredAt: new Date().toISOString(), model: MODEL }, null, 2) + '\n')

    // The same error text recurring across runs is a bug in the harness or the environment,
    // not per-run flakiness in what is being measured — flagged in the console line so a
    // human watching a long run notices it instead of reading 22 lines of identical "ERROR".
    const errorCounts = new Map<string, number>()

    const tasks = scenarios.flatMap(s => arms.map(a => async () => {
      const transcript = await runOne(s, a, allowed[a.name])
      writeTranscriptSafely(join(RUNS_DIR, `${s.id}--${a.name}.json`), transcript, `${s.id} [${a.name}]`)
      let line = `${s.id} [${a.name}] ${transcript.isError ? 'ERROR' : 'ok'} — ${transcript.metrics.toolCalls} calls, ${transcript.metrics.totalTokens} tokens, $${transcript.metrics.costUsd.toFixed(4)}`
      if (transcript.error) {
        const seen = (errorCounts.get(transcript.error) ?? 0) + 1
        errorCounts.set(transcript.error, seen)
        line += ` (${transcript.error})`
        if (seen > 1) line += ` [seen ${seen}x — likely a bug, not per-run flakiness]`
      }
      console.log(line)
      return transcript
    }))
    await pool(tasks, concurrency)
  } finally {
    await fixture.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
