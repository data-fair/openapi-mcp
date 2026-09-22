/**
 * Turns the SDK's message stream into the evidence the judge reads.
 *
 * Shapes verified against the real SDK: `tool_use` blocks arrive on `assistant` messages,
 * and their results on the FOLLOWING `user` message as `tool_result` blocks whose
 * `content` is an array of `{ type: 'text', text }` (occasionally a bare string).
 *
 * Tool names are stripped of their `mcp__<server>__` prefix: the judge is not told which
 * arm it is reading, and a prefix is exactly the kind of tell that would leak it.
 */
import type { ArmName } from './arms.ts'

export interface RecordedCall {
  tool: string
  args: unknown
  response: string
  outputBytes: number
  isError: boolean
}

export interface RunMetrics {
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  costUsd: number
  numTurns: number
}

export interface Transcript {
  scenario: string
  arm: ArmName
  /** The alias passed to the SDK (e.g. `haiku`), from `OPENAPI_MCP_EVAL_MODEL` — not
   * necessarily what a baseline months from now still resolves to. See `resolvedModels`. */
  model: string
  /** The model id(s) the SDK actually billed, read from `result.modelUsage`'s keys (an
   * alias like `haiku` can resolve to a different concrete id over time, which is exactly
   * what would make an old baseline silently incomparable to a new run without this). Empty
   * when the run threw before any `result` message arrived. Optional so transcripts written
   * before this field existed (the committed baseline included) still parse as a `Transcript`. */
  resolvedModels?: string[]
  startedAt: string
  provenance: Record<string, string>
  question: string
  calls: RecordedCall[]
  answer: string
  /** True whenever the run did not produce a usable result: the run threw, the SDK reported
   * `is_error` on the result, or the stream ended with no result message at all. This is the
   * field both the judge and the report key on to treat a harness failure consistently —
   * `error` (below) is only the human-readable detail, present when the failure came from a
   * thrown exception. */
  isError: boolean
  /** Set when the run itself threw (network failure, MCP subprocess crash, auth error, …)
   * rather than completing with a `result` message. Absent when the run completed but still
   * has `isError: true` (e.g. `is_error` on the result, or no result message) — that case is
   * still a harness failure and must still be read as one via `isError`, just without a
   * caught exception's message to quote. */
  error?: string
  metrics: RunMetrics
}

function resultText (content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
  }
  return ''
}

interface PendingCall extends RecordedCall {
  id?: string
  resolved: boolean
}

export function extractCalls (messages: any[]): RecordedCall[] {
  const pending: PendingCall[] = []
  const calls: RecordedCall[] = []

  for (const m of messages) {
    if (m?.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue
        const pendingCall: PendingCall = {
          tool: String(block.name ?? '').replace(/^mcp__.*?__/, ''),
          args: block.input,
          response: '',
          outputBytes: 0,
          isError: false,
          id: block.id,
          resolved: false
        }
        pending.push(pendingCall)
        calls.push(pendingCall)
      }
    } else if (m?.type === 'user') {
      for (const block of m.message?.content ?? []) {
        if (block?.type !== 'tool_result') continue

        // Find the pending call to attach this result to
        let targetCall: PendingCall | undefined

        // If result has tool_use_id, find by id
        if (block.tool_use_id) {
          targetCall = pending.find(c => c.id === block.tool_use_id && !c.resolved)
        }

        // If not found by id, fall back to FIFO (first unresolved)
        if (!targetCall) {
          targetCall = pending.find(c => !c.resolved)
        }

        if (targetCall) {
          targetCall.response = resultText(block.content)
          targetCall.outputBytes = targetCall.response.length
          targetCall.isError = block.is_error === true
          targetCall.resolved = true
        }
      }
    }
  }

  // Return calls without the id and resolved fields
  return calls.map(c => ({
    tool: c.tool,
    args: c.args,
    response: c.response,
    outputBytes: c.outputBytes,
    isError: c.isError
  }))
}

/**
 * The resolved model id(s) the SDK actually billed for this run, read from the keys of
 * `result.modelUsage` — `run.ts` and `judge.ts` only know the alias (`haiku`, `sonnet`)
 * they asked for, and an alias's resolution can move over time. Recording the resolved id
 * is what lets a baseline recorded today be checked against one recorded in six months.
 */
export function extractResolvedModels (result: any): string[] {
  return Object.keys(result?.modelUsage ?? {})
}

export function extractMetrics (result: any, calls: RecordedCall[]): RunMetrics {
  let inputTokens = 0; let outputTokens = 0; let cacheReadTokens = 0; let cacheCreationTokens = 0
  for (const u of Object.values<any>(result?.modelUsage ?? {})) {
    inputTokens += u?.inputTokens ?? 0
    outputTokens += u?.outputTokens ?? 0
    cacheReadTokens += u?.cacheReadInputTokens ?? 0
    cacheCreationTokens += u?.cacheCreationInputTokens ?? 0
  }
  return {
    toolCalls: calls.length,
    toolErrors: calls.filter(c => c.isError).length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    costUsd: result?.total_cost_usd ?? 0,
    numTurns: result?.num_turns ?? 0
  }
}
