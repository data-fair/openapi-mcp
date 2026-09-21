#!/usr/bin/env node
/**
 * Judges each transcript on its own.
 *
 * The judge is never told which arm produced what it is reading: transcript tool names
 * already have their `mcp__<server>__` prefix stripped, and nothing in the prompt names an
 * arm. Two arms judged by one judge that knew which was "the new one" would be one judge
 * grading its own expectations.
 *
 * Its model is pinned separately from the runner's and defaults higher. The runner is
 * deliberately the smallest tier, to stress the tools; reading a transcript carefully is
 * the harder task, and a weak judge yields weak findings.
 *
 * Two failure classes are kept apart, echoing lessons the runner (Task 4) already learned
 * twice over:
 *
 * - A transcript with `isError: true` (the run threw — network failure, MCP subprocess
 *   crash, auth error — or completed with the SDK's own `is_error` on the result, or ended
 *   with no result message at all) never reaches the model: judging "(the agent made no
 *   tool calls)" with an empty answer would almost certainly read as "unsatisfactory", which
 *   biases the B/A comparison this harness exists to produce against whichever arm happens
 *   to fail more (arm A hits a live rate-limited instance, arm B a local fixture — a
 *   structural difference that has nothing to do with tool quality). Such a run is SKIPPED,
 *   not judged and not scored either way. `isError` is the field to key on, not `error`:
 *   `error` is only set when the run threw an exception, but a run that completed without
 *   throwing can still be a harness failure (see `evals/transcript.ts`'s doc comment).
 * - Anything else that goes wrong judging one transcript (malformed judge output, a missing
 *   scenario, a scenario mismatch, the `ask()` call itself failing) is caught per-transcript.
 *   An unjudged run counts as a failure — a transcript nobody read is not evidence — but one
 *   bad transcript must not erase every transcript queued after it. That guarantee covers
 *   the whole per-transcript body, not just `judgeOne`: `judgeFile` wraps reading and
 *   parsing a transcript file, judging it, and writing its verdict back out in one
 *   try/catch, so a truncated or corrupted file (e.g. from a batch interrupted mid-write)
 *   fails just that one transcript instead of aborting every transcript queued after it
 *   alphabetically.
 */
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { isolationOptions, neutralCwd } from './isolation.ts'
import { parseVerdict, type Verdict } from './verdict.ts'
import type { Transcript } from './transcript.ts'

export const JUDGE_MODEL = process.env.OPENAPI_MCP_EVAL_JUDGE_MODEL ?? 'sonnet'
const here = fileURLToPath(new URL('.', import.meta.url))
const RUNS_DIR = join(here, 'runs')

export interface Scenario { id: string, question: string, expected: string }

export function prompt (t: Transcript, expected: string): string {
  const calls = t.calls.map((c, i) => [
    `### Call ${i + 1}: ${c.tool}${c.isError ? ' (returned an error)' : ''}`,
    `Arguments: ${JSON.stringify(c.args)}`,
    'Returned:',
    '```',
    c.response.length > 4000
      ? c.response.slice(0, 4000) + `\n…(truncated by the judge harness at 4,000 of ${c.response.length} characters)`
      : c.response,
    '```'
  ].join('\n')).join('\n\n')

  return `You are judging whether an AI agent, given a set of tools for querying an open-data platform, got where it needed to go.

You are reading ONE session. Judge it on its own terms — do not speculate about other sessions or other tool sets.

## The question the agent was asked
${t.question}

## What a correct answer looks like
${expected}

## What the agent did
${calls || '(the agent made no tool calls)'}

## The answer it gave
${t.answer}

## Your job
Decide whether this session was **satisfactory**: did the agent use the tools to reach an answer of the kind described above, without inventing data? A session that reached a correct answer after recovering from a tool error is still satisfactory — recovery is a property of good tools.

Then list the **friction**: responses that misled the agent, descriptions that promised something the tool then rejected, information it had to fetch twice, or errors it had to work around. Each friction point must be anchored to the 1-based number of the call that caused it. An empty list is a valid and meaningful answer.

Reply with ONLY a JSON object, no prose around it:

{
  "scenario": "${t.scenario}",
  "verdict": "satisfactory" | "unsatisfactory",
  "reasoning": "<one paragraph>",
  "friction": [
    { "call": <1-based number>, "tool": "<tool name>", "observed": "<what that call returned, quoted>", "inferred": "<what the agent apparently concluded>", "severity": "high" | "medium" | "low" }
  ]
}`
}

// The resolved judge model id(s) actually billed for the most recent `ask()` call, read
// from `result.modelUsage`'s keys. `JUDGE_MODEL` is only the alias (`sonnet`) requested; an
// alias's resolution can move over time, which is exactly what would make an old baseline
// silently incomparable to a new run without this. `main()` (sequential, one `ask()` at a
// time) reads this right after each call and records it alongside that verdict — cheap,
// since it costs no extra model call, just reads what the SDK already returned.
let lastResolvedModels: string[] = []

export async function ask (text: string): Promise<string> {
  const cwd = neutralCwd()
  try {
    let answer = ''
    lastResolvedModels = []
    for await (const m of query({ prompt: text, options: { ...isolationOptions(cwd), model: JUDGE_MODEL } })) {
      if (m.type === 'result') {
        answer = (m as any).result ?? ''
        lastResolvedModels = Object.keys((m as any).modelUsage ?? {})
      }
    }
    return answer
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

export type JudgeOutcome =
  | { file: string, status: 'judged', verdict: Verdict }
  | { file: string, status: 'skipped', reason: string }
  | { file: string, status: 'failed', reason: string }

/**
 * Decides and carries out the judging of one transcript, in isolation from every other
 * transcript in the batch: this function throws nothing, so a caller looping over many
 * transcripts can never have one bad file take down the rest. `ask` is injected so this is
 * testable with a synthetic transcript and a stub, never spending a real model call.
 */
export async function judgeOne (
  file: string,
  transcript: Transcript,
  scenarios: Scenario[],
  askFn: (text: string) => Promise<string>
): Promise<JudgeOutcome> {
  if (transcript.isError) {
    // The run itself never produced usable tool calls or an answer — there is nothing here
    // for the judge to assess, and asking anyway would read the harness's own failure as a
    // tool failure. Skip without spending a model call. `isError` catches every harness
    // failure (a thrown exception, the SDK's own `is_error` on the result, or no result
    // message at all) — `transcript.error` alone would miss the last two, since it is only
    // set when the run threw.
    const reason = transcript.error ?? 'the run completed with no usable result (is_error, or no result message)'
    return { file, status: 'skipped', reason: `run failed in the harness, not judged: ${reason}` }
  }

  try {
    const expected = scenarios.find(s => s.id === transcript.scenario)?.expected
    if (!expected) throw new Error(`no scenario named ${transcript.scenario}`)

    const answer = await askFn(prompt(transcript, expected))
    const verdict = parseVerdict(answer)
    if (verdict.scenario !== transcript.scenario) {
      throw new Error(`judge answered for scenario ${verdict.scenario}`)
    }
    return { file, status: 'judged', verdict }
  } catch (err: any) {
    return { file, status: 'failed', reason: err?.message ?? String(err) }
  }
}

/**
 * Reads one transcript file, judges it, and (when judged) writes its verdict back out —
 * the complete per-file body of the batch loop in `main()` below, pulled out so it can be
 * exercised against a real, disposable directory in a test instead of the real `runs/`.
 *
 * Wrapped in its own try/catch covering the read, the judge, and the write together: a
 * truncated or corrupted transcript file (the likeliest trigger is a maintainer
 * interrupting a batch mid-write) must fail only this one file, never abort every
 * transcript queued after it alphabetically — `judgeOne` alone cannot guarantee that, since
 * it starts from an already-parsed transcript.
 *
 * The written verdict's `judgeResolvedModel` comes from `lastResolvedModels`, a side effect
 * of the real `ask()` — accurate whenever `askFn` is `ask` itself (as in `main()` below);
 * an injected test stub does not update it, so it stays whatever it last was (tests only
 * assert the field is present, never a specific value).
 */
export async function judgeFile (
  file: string,
  runsDir: string,
  scenarios: Scenario[],
  askFn: (text: string) => Promise<string>
): Promise<JudgeOutcome> {
  try {
    const transcript: Transcript = JSON.parse(readFileSync(join(runsDir, file), 'utf8'))
    const outcome = await judgeOne(file, transcript, scenarios, askFn)
    if (outcome.status === 'judged') {
      writeFileSync(join(runsDir, file.replace(/\.json$/, '.verdict.json')),
        JSON.stringify({ ...outcome.verdict, judgeModel: JUDGE_MODEL, judgeResolvedModel: lastResolvedModels, judgedAt: new Date().toISOString() }, null, 2) + '\n')
    }
    return outcome
  } catch (err: any) {
    return { file, status: 'failed', reason: err?.message ?? String(err) }
  }
}

async function main () {
  const scenarios: Scenario[] = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'))
  const only = process.argv.slice(2)
  const files = readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('.verdict.json') && f !== 'tool-definitions.json')
    .filter(f => !only.length || only.some(o => f.startsWith(o)))

  if (!files.length) throw new Error(`no transcripts to judge in ${RUNS_DIR} — run eval:run first`)

  let judged = 0; let skipped = 0; let failed = 0
  for (const file of files) {
    const outcome = await judgeFile(file, RUNS_DIR, scenarios, ask)

    if (outcome.status === 'judged') {
      judged++
      console.log(`${file}: ${outcome.verdict.verdict}${outcome.verdict.friction.length ? ` (${outcome.verdict.friction.length} friction)` : ''}`)
    } else if (outcome.status === 'skipped') {
      skipped++
      console.log(`${file}: SKIPPED — ${outcome.reason}`)
    } else {
      failed++
      console.error(`${file}: FAILED TO JUDGE — ${outcome.reason}`)
    }
  }

  console.log(`${judged} judged, ${skipped} skipped (harness failures), ${failed} failed to judge`)
  // A partial pass must not be mistaken for a complete one: an unjudged run is a failure,
  // even though it did not abort the batch.
  if (failed > 0) process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
