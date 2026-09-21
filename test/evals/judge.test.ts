import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeOne, judgeFile, type Scenario } from '../../evals/judge.ts'
import type { Transcript } from '../../evals/transcript.ts'

const scenarios: Scenario[] = [
  { id: 'pagination', question: 'List 20 things', expected: 'Should paginate to get 20 results.' }
]

function transcript (overrides: Partial<Transcript> = {}): Transcript {
  return {
    scenario: 'pagination',
    arm: 'B',
    model: 'haiku',
    startedAt: '2026-09-21T00:00:00.000Z',
    provenance: {},
    question: 'List 20 things',
    calls: [],
    answer: '',
    isError: false,
    metrics: {
      toolCalls: 0,
      toolErrors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      numTurns: 0
    },
    ...overrides
  }
}

const goodVerdictText = JSON.stringify({
  scenario: 'pagination',
  verdict: 'satisfactory',
  reasoning: 'It paginated correctly.',
  friction: []
})

describe('judgeOne', () => {
  it('skips a transcript recorded from a thrown run, without calling ask', async () => {
    const t = transcript({ isError: true, calls: [], answer: '', error: 'MCP subprocess crashed' })
    let askCalled = false
    const stub = async () => { askCalled = true; throw new Error('ask must not be called for a thrown run') }

    const outcome = await judgeOne('pagination--A.json', t, scenarios, stub)

    assert.equal(outcome.status, 'skipped')
    assert.match((outcome as any).reason, /MCP subprocess crashed/)
    assert.equal(askCalled, false, 'a harness failure must not spend a model call')
  })

  it('skips a transcript with isError true but no error message, without calling ask', async () => {
    // A run that completed without throwing but with the SDK's own is_error on the result,
    // or no result message at all, sets isError without setting error (see transcript.ts's
    // doc comment). judgeOne must key on isError, not error, or this class of harness
    // failure gets judged with an empty view and almost certainly scored unsatisfactory.
    const t = transcript({ isError: true, calls: [], answer: '' })
    let askCalled = false
    const stub = async () => { askCalled = true; throw new Error('ask must not be called for an isError run') }

    const outcome = await judgeOne('pagination--A.json', t, scenarios, stub)

    assert.equal(outcome.status, 'skipped')
    assert.match((outcome as any).reason, /no usable result/)
    assert.equal(askCalled, false, 'a harness failure must not spend a model call')
  })

  it('judges a normal transcript by calling ask and parsing its reply', async () => {
    const t = transcript()
    let calledWith = ''
    const stub = async (text: string) => { calledWith = text; return goodVerdictText }

    const outcome = await judgeOne('pagination--B.json', t, scenarios, stub)

    assert.equal(outcome.status, 'judged')
    assert.equal((outcome as any).verdict.verdict, 'satisfactory')
    assert.match(calledWith, /List 20 things/)
  })

  it('fails one transcript without throwing, when the judge reply is unparseable', async () => {
    const t = transcript()
    const stub = async () => 'not json at all'

    const outcome = await judgeOne('pagination--B.json', t, scenarios, stub)

    assert.equal(outcome.status, 'failed')
    assert.match((outcome as any).reason, /could not be parsed as JSON/)
  })

  it('fails when the judge answers for the wrong scenario', async () => {
    const t = transcript()
    const stub = async () => JSON.stringify({ ...JSON.parse(goodVerdictText), scenario: 'other' })

    const outcome = await judgeOne('pagination--B.json', t, scenarios, stub)

    assert.equal(outcome.status, 'failed')
    assert.match((outcome as any).reason, /judge answered for scenario other/)
  })

  it('fails when no scenario matches the transcript, without calling ask', async () => {
    const t = transcript({ scenario: 'nonexistent' })
    let askCalled = false
    const stub = async () => { askCalled = true; return goodVerdictText }

    const outcome = await judgeOne('nonexistent--B.json', t, scenarios, stub)

    assert.equal(outcome.status, 'failed')
    assert.match((outcome as any).reason, /no scenario named nonexistent/)
    assert.equal(askCalled, false)
  })
})

// F1: a truncated or corrupted transcript file (the likeliest trigger is a maintainer
// interrupting a batch mid-write) must fail only that one file, not the whole batch. Exercised
// against a real, disposable directory — no model calls, `ask` is stubbed throughout.
describe('judgeFile', () => {
  it('fails just the one file when its transcript JSON is truncated, leaving the directory otherwise usable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'judge-file-'))
    try {
      const good = transcript()
      writeFileSync(join(dir, 'pagination--A.json'), JSON.stringify(good))
      writeFileSync(join(dir, 'pagination--B.json'), '{"scenario": "pagination", "arm": "B", tru') // truncated mid-write

      const stub = async () => goodVerdictText

      const badOutcome = await judgeFile('pagination--B.json', dir, scenarios, stub)
      assert.equal(badOutcome.status, 'failed')
      assert.ok(badOutcome.status === 'failed' && /JSON|Unexpected/.test(badOutcome.reason))
      assert.equal(existsSync(join(dir, 'pagination--B.verdict.json')), false)

      // The good file, processed independently, is unaffected by the bad one.
      const goodOutcome = await judgeFile('pagination--A.json', dir, scenarios, stub)
      assert.equal(goodOutcome.status, 'judged')
      assert.equal(existsSync(join(dir, 'pagination--A.verdict.json')), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('writes the verdict file for a judged transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'judge-file-'))
    try {
      writeFileSync(join(dir, 'pagination--A.json'), JSON.stringify(transcript()))
      const outcome = await judgeFile('pagination--A.json', dir, scenarios, async () => goodVerdictText)
      assert.equal(outcome.status, 'judged')
      const verdict = JSON.parse(readFileSync(join(dir, 'pagination--A.verdict.json'), 'utf8'))
      assert.equal(verdict.verdict, 'satisfactory')
      assert.ok('judgeModel' in verdict)
      assert.ok('judgeResolvedModel' in verdict, 'F7: records the resolved judge model id(s) alongside the verdict')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not write a verdict file when the transcript is skipped (isError)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'judge-file-'))
    try {
      writeFileSync(join(dir, 'pagination--A.json'), JSON.stringify(transcript({ isError: true, error: 'boom' })))
      const outcome = await judgeFile('pagination--A.json', dir, scenarios, async () => { throw new Error('must not be called') })
      assert.equal(outcome.status, 'skipped')
      assert.equal(existsSync(join(dir, 'pagination--A.verdict.json')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
