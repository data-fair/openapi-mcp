import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractCalls, extractMetrics, extractResolvedModels } from '../../evals/transcript.ts'

const messages = [
  { type: 'system' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Je cherche.' }, { type: 'tool_use', name: 'mcp__datafair__list_datasets', input: { q: 'communes' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: '- **count**: 421' }] }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__datafair__search_data', input: { datasetId: 'x' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'HTTP 400: field unknown' }] }] } },
  { type: 'result', subtype: 'success' }
]

describe('extractCalls', () => {
  it('pairs each tool_use with the tool_result that follows it', () => {
    const calls = extractCalls(messages)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[0], { tool: 'list_datasets', args: { q: 'communes' }, response: '- **count**: 421', outputBytes: 16, isError: false })
    assert.equal(calls[1].tool, 'search_data')
    assert.equal(calls[1].isError, true)
    assert.equal(calls[1].response, 'HTTP 400: field unknown')
  })
  it('strips the mcp__<server>__ prefix so the judge cannot infer the arm', () => {
    assert.ok(extractCalls(messages).every(c => !c.tool.includes('mcp__')))
  })
  it('records a call whose result never arrived rather than dropping it', () => {
    const calls = extractCalls([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__datafair__x', input: {} }] } }])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].response, '')
    assert.equal(calls[0].isError, false)
  })
  it('handles a string tool_result content', () => {
    const calls = extractCalls([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__datafair__x', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'plain text' }] } }
    ])
    assert.equal(calls[0].response, 'plain text')
  })
  it('pairs two tool_use blocks in one message with two tool_result blocks by id', () => {
    const calls = extractCalls([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'mcp__datafair__list_datasets', input: { q: 'communes' } },
            { type: 'tool_use', id: 'toolu_2', name: 'mcp__datafair__search_data', input: { datasetId: 'x' } }
          ]
        }
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'result 1' }] },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'result 2' }] }
          ]
        }
      }
    ])
    assert.equal(calls.length, 2)
    assert.equal(calls[0].tool, 'list_datasets')
    assert.equal(calls[0].response, 'result 1')
    assert.equal(calls[1].tool, 'search_data')
    assert.equal(calls[1].response, 'result 2')
  })
  it('pairs two tool_use blocks without ids using FIFO fallback', () => {
    const calls = extractCalls([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__datafair__list_datasets', input: { q: 'communes' } },
            { type: 'tool_use', name: 'mcp__datafair__search_data', input: { datasetId: 'x' } }
          ]
        }
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', content: [{ type: 'text', text: 'result 1' }] },
            { type: 'tool_result', content: [{ type: 'text', text: 'result 2' }] }
          ]
        }
      }
    ])
    assert.equal(calls.length, 2)
    assert.equal(calls[0].tool, 'list_datasets')
    assert.equal(calls[0].response, 'result 1')
    assert.equal(calls[1].tool, 'search_data')
    assert.equal(calls[1].response, 'result 2')
  })
  it('handles tool results arriving out of order by id', () => {
    const calls = extractCalls([
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'mcp__datafair__list_datasets', input: { q: 'communes' } },
            { type: 'tool_use', id: 'toolu_2', name: 'mcp__datafair__search_data', input: { datasetId: 'x' } }
          ]
        }
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'result 2' }] },
            { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'result 1' }] }
          ]
        }
      }
    ])
    assert.equal(calls.length, 2)
    assert.equal(calls[0].tool, 'list_datasets')
    assert.equal(calls[0].response, 'result 1')
    assert.equal(calls[1].tool, 'search_data')
    assert.equal(calls[1].response, 'result 2')
  })
  it('strips the mcp__<server>__ prefix from server names with underscores', () => {
    const calls = extractCalls([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__data_fair__list_datasets', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'result' }] }] } }
    ])
    assert.equal(calls[0].tool, 'list_datasets')
    assert.ok(!calls[0].tool.includes('mcp__'))
  })
  it('leaves bare tool names (without mcp__ prefix) untouched', () => {
    const calls = extractCalls([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'list_datasets', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'result' }] }] } }
    ])
    assert.equal(calls[0].tool, 'list_datasets')
  })
})

describe('extractMetrics', () => {
  it('sums tokens across every model in modelUsage and counts tool errors', () => {
    const result = {
      num_turns: 4,
      total_cost_usd: 0.0123,
      modelUsage: {
        'claude-haiku-4-5': { inputTokens: 945, outputTokens: 521, cacheReadInputTokens: 13075, cacheCreationInputTokens: 3116 },
        'claude-other': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
      }
    }
    const m = extractMetrics(result, extractCalls(messages))
    assert.equal(m.inputTokens, 955)
    assert.equal(m.outputTokens, 526)
    assert.equal(m.cacheReadTokens, 13075)
    assert.equal(m.cacheCreationTokens, 3116)
    assert.equal(m.totalTokens, 955 + 526 + 13075 + 3116)
    assert.equal(m.costUsd, 0.0123)
    assert.equal(m.numTurns, 4)
    assert.equal(m.toolCalls, 2)
    assert.equal(m.toolErrors, 1)
  })
  it('treats a result with no modelUsage as zeros rather than throwing', () => {
    const m = extractMetrics({ num_turns: 0, total_cost_usd: 0 }, [])
    assert.equal(m.totalTokens, 0)
    assert.equal(m.toolCalls, 0)
  })
})

// F7: an alias like `haiku` can resolve to a different concrete model id over time, which is
// exactly what would make an old baseline silently incomparable to a new run without this.
describe('extractResolvedModels', () => {
  it('reads the resolved model id(s) from modelUsage\'s keys', () => {
    const result = {
      modelUsage: {
        'claude-haiku-4-5-20251115': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
      }
    }
    assert.deepEqual(extractResolvedModels(result), ['claude-haiku-4-5-20251115'])
  })
  it('returns every model id when a run used more than one', () => {
    const result = { modelUsage: { 'claude-haiku-4-5': {}, 'claude-other': {} } }
    assert.deepEqual(extractResolvedModels(result), ['claude-haiku-4-5', 'claude-other'])
  })
  it('returns an empty array rather than throwing when there is no result at all', () => {
    assert.deepEqual(extractResolvedModels(null), [])
    assert.deepEqual(extractResolvedModels({}), [])
  })
})
