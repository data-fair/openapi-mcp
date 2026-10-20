#!/usr/bin/env node
/**
 * Runs each scenario against the server under evaluation and writes one transcript per scenario.
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
import { serverSpec, discoverTools, type ServerSpec } from './server.ts'
import { startFixtureServer } from './fixture-server.ts'
import { extractCalls, extractMetrics, extractResolvedModels, type Transcript } from './transcript.ts'

const MODEL = process.env.OPENAPI_MCP_EVAL_MODEL ?? 'haiku'
const here = fileURLToPath(new URL('.', import.meta.url))
const RUNS_DIR = join(here, 'runs')

interface Scenario { id: string, question: string, expected: string }

function parseArgs (argv: string[]) {
  const ids: string[] = []
  let concurrency = 1
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--concurrency') {
      const raw = argv[++i]
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1) throw new Error(`--concurrency must be a positive integer, got ${JSON.stringify(raw)}`)
      concurrency = n
    } else ids.push(argv[i])
  }
  return { ids, concurrency }
}

/**
 * A run that throws (creating the neutral cwd, the query() call itself — network failure,
 * MCP subprocess crash, auth error — cleanup, or extracting the transcript) is recorded as
 * a datum, never left to crash the batch: the try/catch below covers the whole body,
 * including cwd creation, so every throw path in a run is caught the same way.
 */
async function runOne (scenario: Scenario, server: ServerSpec, allowedTools: string[]): Promise<Transcript> {
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
          mcpServers: { [server.name]: server.config }
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
      model: MODEL,
      resolvedModels: extractResolvedModels(result),
      startedAt,
      provenance: server.provenance,
      question: scenario.question,
      calls,
      answer: result?.result ?? '',
      isError: result?.is_error === true || result == null,
      metrics: extractMetrics(result, calls)
    }
  } catch (err: any) {
    return {
      scenario: scenario.id,
      model: MODEL,
      resolvedModels: [],
      startedAt,
      provenance: server.provenance,
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
  const { ids, concurrency } = parseArgs(process.argv.slice(2))
  const all: Scenario[] = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'))
  const scenarios = ids.length ? all.filter(s => ids.includes(s.id)) : all
  if (!scenarios.length) throw new Error(`no scenarios matched ${ids.join(', ')}`)

  mkdirSync(RUNS_DIR, { recursive: true })
  const fixture = await startFixtureServer()
  try {
    const server = serverSpec(fixture.url, fixture.hash)
    const { allowedTools, ...defs } = await discoverTools(server)
    console.log(`${defs.toolNames.length} tools, ${defs.definitionBytes} bytes of definitions, ${defs.instructionsBytes} bytes of instructions`)
    writeFileSync(join(RUNS_DIR, 'tool-definitions.json'), JSON.stringify({ ...defs, measuredAt: new Date().toISOString(), model: MODEL }, null, 2) + '\n')

    // The same error text recurring across runs is a harness or environment bug, not flakiness
    // in what is measured: say so in the console line.
    const errorCounts = new Map<string, number>()
    const tasks = scenarios.map(s => async () => {
      const transcript = await runOne(s, server, allowedTools)
      writeTranscriptSafely(join(RUNS_DIR, `${s.id}.json`), transcript, s.id)
      let line = `${s.id} ${transcript.isError ? 'ERROR' : 'ok'}: ${transcript.metrics.toolCalls} calls, ${transcript.metrics.totalTokens} tokens, $${transcript.metrics.costUsd.toFixed(4)}`
      if (transcript.error) {
        const seen = (errorCounts.get(transcript.error) ?? 0) + 1
        errorCounts.set(transcript.error, seen)
        line += ` (${transcript.error})`
        if (seen > 1) line += ` [seen ${seen}x: likely a bug, not flakiness]`
      }
      console.log(line)
      return transcript
    })
    await pool(tasks, concurrency)
  } finally {
    await fixture.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
