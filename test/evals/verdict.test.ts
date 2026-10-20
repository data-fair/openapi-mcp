import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerdict } from '../../evals/verdict.ts'

const good = {
  scenario: 'pagination',
  verdict: 'satisfactory',
  reasoning: 'The agent listed datasets, then paginated with size and after.',
  friction: [{ call: 2, tool: 'search_data', observed: 'HTTP 400: field unknown', inferred: 'guessed a column name', severity: 'medium' }]
}

describe('parseVerdict', () => {
  it('accepts a bare JSON object', () => {
    assert.deepEqual(parseVerdict(JSON.stringify(good)), good)
  })
  it('accepts a fenced JSON block with prose around it', () => {
    assert.deepEqual(parseVerdict('Here is my verdict:\n```json\n' + JSON.stringify(good) + '\n```\nDone.'), good)
  })
  it('accepts an empty friction list', () => {
    const v = parseVerdict(JSON.stringify({ ...good, friction: [] }))
    assert.deepEqual(v.friction, [])
  })
  it('rejects unparseable text', () => {
    assert.throws(() => parseVerdict('I think it went fine, honestly.'), /could not be parsed as JSON/)
  })
  it('rejects an unknown verdict value', () => {
    assert.throws(() => parseVerdict(JSON.stringify({ ...good, verdict: 'great' })), /verdict must be one of/)
  })
  it('rejects empty reasoning', () => {
    assert.throws(() => parseVerdict(JSON.stringify({ ...good, reasoning: '   ' })), /reasoning must explain/)
  })
  it('rejects a friction point that anchors nothing', () => {
    assert.throws(() => parseVerdict(JSON.stringify({ ...good, friction: [{ ...good.friction[0], call: 0 }] })),
      /friction\[0\]\.call must be the 1-based call number/)
  })
  it('rejects an unknown severity', () => {
    assert.throws(() => parseVerdict(JSON.stringify({ ...good, friction: [{ ...good.friction[0], severity: 'urgent' }] })),
      /friction\[0\]\.severity must be one of/)
  })
  it('rejects a missing friction array', () => {
    const { friction, ...rest } = good
    assert.throws(() => parseVerdict(JSON.stringify(rest)), /friction must be an array/)
  })
})
