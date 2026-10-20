import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarise, fillMissingRuns, readRunSet, type Run } from '../../evals/report.ts'

const t = (scenario: string, totalTokens: number, io = { inputTokens: 0, outputTokens: 0 }) => ({
  scenario,
  model: 'haiku',
  startedAt: '2026-09-20T10:00:00.000Z',
  provenance: {},
  question: 'q',
  calls: [],
  answer: 'a',
  isError: false,
  metrics: { toolCalls: 2, toolErrors: 0, ...io, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens, costUsd: 0.01, numTurns: 2 }
}) as any

const v = (scenario: string, verdict: 'satisfactory' | 'unsatisfactory', friction = 0) => ({
  scenario,
  verdict,
  reasoning: 'r',
  friction: Array.from({ length: friction }, (_, i) => ({ call: i + 1, tool: 'x', observed: 'o', inferred: 'i', severity: 'low' as const }))
})

const set = (runs: Run[]) => ({ runs, toolDefs: null })

describe('summarise', () => {
  it('counts passes, friction and tokens, input+output apart', () => {
    const { lines, failed } = summarise(set([
      { scenario: 's1', transcript: t('s1', 60000, { inputTokens: 1500, outputTokens: 1000 }), verdict: v('s1', 'satisfactory', 2) },
      { scenario: 's2', transcript: t('s2', 1000), verdict: v('s2', 'unsatisfactory', 1) }
    ]))
    const text = lines.join('\n')
    assert.equal(failed, false)
    assert.match(text, /1\/2 satisfactory, 3 friction points, 61000 tokens \(input\+output 2500\)/)
    assert.match(text, /\| s2 \| \*\*fail\*\* \|/)
  })
  it('fails on a run that never ran, was not judged, or failed in the harness, each in its own bucket', () => {
    const crashed = t('s3', 0)
    crashed.isError = true
    crashed.error = 'the MCP subprocess crashed on startup'
    const noResult = t('s4', 0)
    noResult.isError = true // no error message: is_error on the result, or no result message
    const { lines, failed } = summarise(set([
      { scenario: 's1', transcript: null, verdict: null },
      { scenario: 's2', transcript: t('s2', 100), verdict: null },
      { scenario: 's3', transcript: crashed, verdict: null },
      { scenario: 's4', transcript: noResult, verdict: null }
    ]))
    const text = lines.join('\n')
    assert.equal(failed, true)
    assert.match(text, /\| s1 \| \*\*never ran\*\* \|/)
    assert.match(text, /\| s3 \| \*\*harness error\*\*: the MCP subprocess crashed on startup \|/)
    assert.match(text, /\| s4 \| \*\*harness error\*\*/)
    assert.match(text, /never ran: 1, not judged: 1, harness errors: 2/)
  })
  it('compares with a baseline: changed verdicts, totals and the token ratio', () => {
    const current = { runs: [{ scenario: 's1', transcript: t('s1', 2000, { inputTokens: 200, outputTokens: 100 }), verdict: v('s1', 'satisfactory') }], toolDefs: { toolNames: ['a'], definitionBytes: 900, instructionsBytes: 100 } }
    const baseline = { runs: [{ scenario: 's1', transcript: t('s1', 1000, { inputTokens: 100, outputTokens: 50 }), verdict: v('s1', 'unsatisfactory') }], toolDefs: { toolNames: ['a'], definitionBytes: 800 } }
    const text = summarise(current, baseline).lines.join('\n')
    assert.match(text, /\| s1 \| pass \(was fail\) \|/)
    assert.match(text, /baseline: 0\/1 satisfactory/)
    assert.match(text, /tool definitions: 1 tools, 900 bytes definitions \+ 100 bytes instructions/)
    assert.match(text, /baseline tool definitions: 1 tools, 800 bytes/)
    assert.match(text, /token ratio to baseline: 2\.00 \(input\+output 2\.00\)/)
  })
})

describe('fillMissingRuns', () => {
  it('adds a never-ran row for a scenario without a run, and keeps the others', () => {
    const real = t('s1', 100)
    const runs = fillMissingRuns([{ id: 's1' }, { id: 's2' }], [{ scenario: 's1', transcript: real, verdict: null }])
    assert.equal(runs.find(r => r.scenario === 's1')!.transcript, real)
    assert.deepEqual(runs.find(r => r.scenario === 's2'), { scenario: 's2', transcript: null, verdict: null })
  })
})

describe('readRunSet', () => {
  it('reads transcripts and verdicts, and a file that does not parse loses only its own run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-report-'))
    try {
      writeFileSync(join(dir, 's1.json'), JSON.stringify(t('s1', 100)))
      writeFileSync(join(dir, 's1.verdict.json'), JSON.stringify(v('s1', 'satisfactory')))
      writeFileSync(join(dir, 's2.json'), '{"scenario": "s2", tru')
      writeFileSync(join(dir, 'tool-definitions.json'), JSON.stringify({ toolNames: ['a'], definitionBytes: 10 }))
      const { runs, toolDefs } = readRunSet(dir)
      assert.equal(runs.find(r => r.scenario === 's1')!.verdict!.verdict, 'satisfactory')
      assert.equal(runs.find(r => r.scenario === 's2')!.transcript, null)
      assert.deepEqual(toolDefs, { toolNames: ['a'], definitionBytes: 10 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
