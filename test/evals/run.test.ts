import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTranscriptSafely } from '../../evals/run.ts'
import type { Transcript } from '../../evals/transcript.ts'

function transcript (): Transcript {
  return {
    scenario: 'pagination',
    arm: 'A',
    model: 'haiku',
    resolvedModels: ['claude-haiku-4-5-20251115'],
    startedAt: '2026-09-21T00:00:00.000Z',
    provenance: {},
    question: 'List 20 things',
    calls: [],
    answer: 'done',
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
    }
  }
}

// F1: this write was the last unguarded statement left in the batch loop (runOne itself
// cannot throw). A write failure here must never propagate — pool()'s Promise.all would
// reject and take every still-queued run down with it.
describe('writeTranscriptSafely', () => {
  it('writes the transcript to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run-write-'))
    try {
      const path = join(dir, 'pagination--A.json')
      writeTranscriptSafely(path, transcript(), 'pagination [A]')
      assert.equal(existsSync(path), true)
      const written = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(written.scenario, 'pagination')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not throw when the write fails (e.g. the directory does not exist)', () => {
    const missing = join(tmpdir(), 'run-write-does-not-exist', 'pagination--A.json')
    assert.doesNotThrow(() => writeTranscriptSafely(missing, transcript(), 'pagination [A]'))
    assert.equal(existsSync(missing), false)
  })
})
