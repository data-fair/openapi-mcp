import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarise, fillMissingRuns, type Run } from '../../evals/report.ts'

const t = (scenario: string, arm: 'A' | 'B', totalTokens: number, toolCalls = 2, toolErrors = 0) => ({
  scenario,
  arm,
  model: 'haiku',
  startedAt: '2026-09-20T10:00:00.000Z',
  provenance: {},
  question: 'q',
  calls: [],
  answer: 'a',
  isError: false,
  metrics: { toolCalls, toolErrors, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens, costUsd: 0.01, numTurns: 2 }
}) as any

// A variant that sets inputTokens/outputTokens independently of totalTokens, so cache's
// share of the total can dwarf input+output the way the real pagination--B transcript does
// (2,315 input+output against 60,925 total).
const io = (scenario: string, arm: 'A' | 'B', inputTokens: number, outputTokens: number, totalTokens: number) => ({
  scenario,
  arm,
  model: 'haiku',
  startedAt: '2026-09-20T10:00:00.000Z',
  provenance: {},
  question: 'q',
  calls: [],
  answer: 'a',
  isError: false,
  metrics: { toolCalls: 2, toolErrors: 0, inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens, costUsd: 0.01, numTurns: 2 }
}) as any

const v = (scenario: string, verdict: 'satisfactory' | 'unsatisfactory', friction = 0) => ({
  scenario,
  verdict,
  reasoning: 'r',
  friction: Array.from({ length: friction }, (_, i) => ({ call: i + 1, tool: 'x', observed: 'o', inferred: 'i', severity: 'low' as const }))
})

describe('summarise', () => {
  it('reports the B/A token ratio against the 1.2 criterion', () => {
    const runs: Run[] = [
      { scenario: 's1', arm: 'A', transcript: t('s1', 'A', 1000), verdict: v('s1', 'satisfactory') },
      { scenario: 's1', arm: 'B', transcript: t('s1', 'B', 1100), verdict: v('s1', 'satisfactory') }
    ]
    const { lines, failed } = summarise(runs, { A: { toolNames: ['x'], definitionBytes: 9000 }, B: { toolNames: ['y'], definitionBytes: 15136 } })
    const text = lines.join('\n')
    assert.match(text, /B\/A token ratio: 1\.10/)
    assert.match(text, /≤ 1\.2/)
    assert.match(text, /9000/)
    assert.match(text, /15136/)
    assert.equal(failed, false)
  })
  it('reports a ratio over the criterion without failing the report', () => {
    const runs: Run[] = [
      { scenario: 's1', arm: 'A', transcript: t('s1', 'A', 1000), verdict: v('s1', 'satisfactory') },
      { scenario: 's1', arm: 'B', transcript: t('s1', 'B', 2000), verdict: v('s1', 'satisfactory') }
    ]
    const { lines, failed } = summarise(runs, null)
    assert.match(lines.join('\n'), /2\.00.*over/s)
    assert.equal(failed, false)
  })
  it('fails when a run has no transcript', () => {
    const { lines, failed } = summarise([{ scenario: 's1', arm: 'B', transcript: null, verdict: null }], null)
    assert.equal(failed, true)
    // NOTE: the brief's Step 1 test asserted /s1 \[B\].*never ran/ (a "s1 [B]" bracket
    // form), but the brief's own Step 3 code renders every row, this one included, as a
    // pipe-delimited markdown table cell: `| s1 | B | **never ran** | ... |`. No bracket
    // form is produced anywhere in the file. Judged the code correct, since the table
    // format is used consistently for every row (and matches the printed header), and
    // fixed this one assertion to match it rather than inventing a second row format.
    assert.match(lines.join('\n'), /\| s1 \| B \| \*\*never ran\*\* \|/)
  })
  it('fails when a transcript was never judged', () => {
    const { failed, lines } = summarise([{ scenario: 's1', arm: 'B', transcript: t('s1', 'B', 100), verdict: null }], null)
    assert.equal(failed, true)
    assert.match(lines.join('\n'), /not judged/)
  })
  it('counts pass rate per arm and totals friction', () => {
    const runs: Run[] = [
      { scenario: 's1', arm: 'A', transcript: t('s1', 'A', 100), verdict: v('s1', 'satisfactory') },
      { scenario: 's2', arm: 'A', transcript: t('s2', 'A', 100), verdict: v('s2', 'unsatisfactory') },
      { scenario: 's1', arm: 'B', transcript: t('s1', 'B', 100), verdict: v('s1', 'satisfactory', 2) },
      { scenario: 's2', arm: 'B', transcript: t('s2', 'B', 100), verdict: v('s2', 'satisfactory', 1) }
    ]
    const text = summarise(runs, null).lines.join('\n')
    assert.match(text, /arm A: 1\/2 satisfactory/)
    assert.match(text, /arm B: 2\/2 satisfactory/)
    assert.match(text, /friction points: A 0, B 3/)
  })

  // Controller addition 1: a transcript that carries `error` failed in the harness itself
  // (network failure, subprocess crash) before any tool was ever exercised. That must not
  // read the same as a transcript the judge simply never got to.
  it('renders a harness-failed run distinctly from an unjudged one, and still fails the report', () => {
    const failedRun = t('s1', 'B', 0)
    failedRun.error = 'fetch failed: ECONNREFUSED 127.0.0.1:4000'
    failedRun.isError = true
    const { lines, failed } = summarise([{ scenario: 's1', arm: 'B', transcript: failedRun, verdict: null }], null)
    const text = lines.join('\n')
    assert.equal(failed, true)
    assert.match(text, /harness error/)
    assert.match(text, /ECONNREFUSED/)
    assert.doesNotMatch(text, /\*\*not judged\*\*/)
  })

  // isError is set whenever a run has no usable result — a thrown exception (which also
  // sets error), the SDK's own is_error on the result, or a stream that ended with no
  // result message at all. Only the first of those three sets `error`. The report must
  // still bucket all three as a harness error, or the last two get judged like a tool
  // failure and bias the B/A comparison.
  it('treats isError without an error message as a harness error, not a plain tool failure', () => {
    const noResultRun = t('s1', 'B', 0)
    noResultRun.isError = true // no .error set — e.g. is_error on the result, or no result message
    const { lines, failed } = summarise([{ scenario: 's1', arm: 'B', transcript: noResultRun, verdict: null }], null)
    const text = lines.join('\n')
    assert.equal(failed, true)
    assert.match(text, /harness error/)
    assert.doesNotMatch(text, /\*\*not judged\*\*/)
  })

  it('counts harness errors in their own bucket, separate from not-judged and fail', () => {
    const harnessFailed = t('s2', 'B', 0)
    harnessFailed.error = 'the MCP subprocess crashed on startup'
    harnessFailed.isError = true
    const runs: Run[] = [
      { scenario: 's1', arm: 'B', transcript: t('s1', 'B', 100), verdict: null }, // not judged
      { scenario: 's2', arm: 'B', transcript: harnessFailed, verdict: null } // harness error
    ]
    const { lines, failed } = summarise(runs, null)
    const text = lines.join('\n')
    assert.equal(failed, true)
    assert.match(text, /not judged: 1/)
    assert.match(text, /harness errors: 1/)
  })

  // Controller addition 2: totalTokens is dominated by cache (a real transcript measured
  // 58,610 of 60,925 total tokens as cache), and B's larger tool definitions give it a
  // structurally higher cache cost regardless of interaction quality. The headline ratio
  // must stay on totalTokens (the spec's criterion), but input+output must also be broken
  // out on its own clearly-labelled line so the two cannot be confused.
  it('reports input+output tokens and their own B/A ratio, separately from the cache-inclusive headline', () => {
    const runs: Run[] = [
      { scenario: 's1', arm: 'A', transcript: io('s1', 'A', 1000, 500, 20000), verdict: v('s1', 'satisfactory') },
      { scenario: 's1', arm: 'B', transcript: io('s1', 'B', 1500, 1000, 60000), verdict: v('s1', 'satisfactory') }
    ]
    const text = summarise(runs, null).lines.join('\n')
    // headline stays on totalTokens: 60000 / 20000 = 3.00
    assert.match(text, /B\/A token ratio: 3\.00/)
    // input+output only: (1500+1000) / (1000+500) = 1.67
    assert.match(text, /input\+output/i)
    assert.match(text, /1\.67/)
    assert.match(text, /A 1500, B 2500/)
  })

  it('reports instructionsBytes alongside definitionBytes when tool-definitions.json has it', () => {
    const text = summarise([], {
      A: { toolNames: ['x'], definitionBytes: 10899, instructionsBytes: 3033 },
      B: { toolNames: ['y'], definitionBytes: 15136, instructionsBytes: 1156 }
    }).lines.join('\n')
    assert.match(text, /10899 bytes definitions \+ 3033 bytes instructions = 13932 bytes/)
    assert.match(text, /15136 bytes definitions \+ 1156 bytes instructions = 16292 bytes/)
  })

  it('falls back to the plain byte count when instructionsBytes is absent (the committed baseline\'s shape)', () => {
    const text = summarise([], { A: { toolNames: ['x'], definitionBytes: 10899 }, B: { toolNames: ['y'], definitionBytes: 15136 } }).lines.join('\n')
    assert.match(text, /A 1 tools, 10899 bytes;/)
  })
})

describe('fillMissingRuns', () => {
  it('adds a never-ran row for a scenario x arm pair with no transcript', () => {
    const scenarios = [{ id: 's1' }, { id: 's2' }]
    const existing: Run[] = [{ scenario: 's1', arm: 'A', transcript: t('s1', 'A', 100), verdict: v('s1', 'satisfactory') }]

    const runs = fillMissingRuns(scenarios, existing, ['A'])

    assert.equal(runs.length, 2)
    const missing = runs.find(r => r.scenario === 's2' && r.arm === 'A')
    assert.ok(missing)
    assert.equal(missing!.transcript, null)
    assert.equal(missing!.verdict, null)
  })

  it('fills every scenario x arm pair when nothing ran at all', () => {
    const runs = fillMissingRuns([{ id: 's1' }], [], ['A', 'B'])
    assert.equal(runs.length, 2)
    assert.ok(runs.every(r => r.transcript === null && r.verdict === null))
  })

  it('leaves an existing run untouched rather than overwriting it with a blank one', () => {
    const real = t('s1', 'A', 100)
    const runs = fillMissingRuns([{ id: 's1' }], [{ scenario: 's1', arm: 'A', transcript: real, verdict: v('s1', 'satisfactory') }], ['A'])
    assert.equal(runs.length, 1)
    assert.equal(runs[0].transcript, real)
  })

  it('never fills an arm that was not passed in, even if scenarios exist for it', () => {
    // e.g. a run invoked with --arm A: arm B never ran by design, not by failure, so it
    // must not show up as "never ran" rows.
    const runs = fillMissingRuns([{ id: 's1' }], [], ['A'])
    assert.equal(runs.length, 1)
    assert.equal(runs[0].arm, 'A')
  })
})
