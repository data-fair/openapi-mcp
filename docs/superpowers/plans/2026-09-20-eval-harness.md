# Eval harness (phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether the six `explore` tools produced from `x-agent` annotations let an agent get as far, as cheaply, as the seven hand-written tools in `@data-fair/agent-tools-data-fair`.

**Architecture:** One `query()` from `@anthropic-ai/claude-agent-sdk` per (scenario × arm), isolated the way `data-fair/agents`' `lib-sim` established. The two arms differ only in one `mcpServers` entry. Each run writes a transcript JSON; a judge reads one transcript at a time without being told its arm and returns a validated verdict with friction points anchored to call numbers; a report prints the table and the three totals.

**Tech Stack:** Node 24 running `.ts` directly, `node --test`, `@anthropic-ai/claude-agent-sdk` (devDependency, authenticates off Claude Code's own credentials — no API key), `@modelcontextprotocol/sdk` (already a dependency) for tool discovery.

**Spec:** `docs/superpowers/specs/2026-09-19-eval-harness-design.md` — read it first; this plan argues from it.

## Global Constraints

- `@anthropic-ai/claude-agent-sdk` is a **devDependency** (`^0.3.269`). The library gains no runtime dependency.
- **`allowedTools` must name every tool of the arm under test, or every tool call is denied and the run is worthless.** This was verified by probe: without it the agent called one tool, was refused, and answered "Je rencontre un problème de permissions" — a run that looks like a failure of the tools but is a failure of the harness. Names are `mcp__<serverName>__<toolName>`.
- **`modelUsage` is the token field**, not `usage` — the SDK's own docs say `usage` covers the main agent loop only and "prefer modelUsage for token/cost accounting".
- The runner prompt is **the scenario question and nothing else**. Each server supplies its own `instructions` through the protocol; harness-side hints would measure the harness.
- Isolation options are fixed and nothing may override them: freshly-made temp cwd, `settingSources: []`, `tools: []`, `CLAUDE_CODE_*` scrubbed from env, `strictMcpConfig: true`.
- Runner model from `OPENAPI_MCP_EVAL_MODEL`, default `haiku`. Judge model from `OPENAPI_MCP_EVAL_JUDGE_MODEL`, default `sonnet`. Both recorded in every artifact.
- Sequential by default (22 runs against one rate-limited public instance; a 429 lands as a tool error and corrupts the comparison).
- A run that errors is recorded, never silently retried. A missing transcript fails the report loudly.
- Local imports use the `.ts` extension. `npm run quality` green before every commit.
- Conventional commit messages.

## File structure

```
evals/
  scenarios.json     11 scenarios, copied from data-fair/mcp (geocode-address dropped)
  isolation.ts       neutralCwd, scrubEnv, isolationOptions
  arms.ts            arm configs, tool discovery, provenance
  transcript.ts      transcript types + extraction from the SDK message stream
  fixture-server.ts  serves the annotated frozen doc on an ephemeral port
  run.ts             CLI: run (scenario x arm), write evals/runs/*.json
  verdict.ts         verdict schema + parser
  judge.ts           CLI: judge transcripts -> evals/runs/*.verdict.json
  report.ts          CLI: summarise runs into a table
  runs/              working output (gitignored)
  baselines/<date>/  committed snapshot of a full run
test/evals/
  isolation.test.ts  transcript.test.ts  arms.test.ts
  verdict.test.ts    report.test.ts      fixture-server.test.ts
```

---

### Task 1: Scaffolding, scenarios and isolation

**Files:**
- Create: `evals/scenarios.json`, `evals/isolation.ts`, `test/evals/isolation.test.ts`
- Modify: `package.json` (devDependency + scripts), `.gitignore`

**Interfaces:**
- Produces: `neutralCwd(): string`, `scrubEnv(env: Env): Env`, `isolationOptions(cwd: string, env?: Env)`, and the `eval:*` npm scripts every later task extends.

- [ ] **Step 1: Copy the scenarios, dropping `geocode-address`**

```bash
node -e "
const s=require('/home/alban/data-fair/mcp/evals/scenarios.json').filter(x=>x.id!=='geocode-address')
require('fs').writeFileSync('evals/scenarios.json', JSON.stringify(s,null,2)+'\n')
console.log(s.length,'scenarios:',s.map(x=>x.id).join(','))
"
```
Expected: `11 scenarios: search-air-quality,describe-dataset,calculate-metric,filter-search,field-values,aggregation,multi-step-analysis,stats-metric,empty-results,explore-unknown,pagination`

- [ ] **Step 2: Add the devDependency, scripts and gitignore entry**

`package.json` — add to `devDependencies`: `"@anthropic-ai/claude-agent-sdk": "^0.3.269"`. Add to `scripts`:
```json
"eval:run": "node evals/run.ts",
"eval:judge": "node evals/judge.ts",
"eval:report": "node evals/report.ts",
"eval": "npm run eval:run && npm run eval:judge && npm run eval:report"
```
`.gitignore` — add `evals/runs`.

Run `npm install`.

- [ ] **Step 3: Write the failing isolation test**

`test/evals/isolation.test.ts`:
```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { neutralCwd, scrubEnv, isolationOptions } from '../../evals/isolation.ts'

describe('neutralCwd', () => {
  it('creates a real directory outside the repo whose name carries no signal', () => {
    const dir = neutralCwd()
    assert.ok(existsSync(dir))
    assert.ok(!dir.includes('openapi-mcp'), 'cwd path must not name the project')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('scrubEnv', () => {
  it('removes every CLAUDE_CODE_ variable and keeps the rest', () => {
    const out = scrubEnv({ PATH: '/usr/bin', CLAUDE_CODE_FOO: 'x', CLAUDE_CODE_BAR: 'y', HOME: '/home/u' })
    assert.deepEqual(out, { PATH: '/usr/bin', HOME: '/home/u' })
  })
  it('does not mutate its argument', () => {
    const env = { CLAUDE_CODE_FOO: 'x' }
    scrubEnv(env)
    assert.equal(env.CLAUDE_CODE_FOO, 'x')
  })
})

describe('isolationOptions', () => {
  it('fixes the four options that make a run isolated', () => {
    const o = isolationOptions('/tmp/x', { CLAUDE_CODE_FOO: 'x', PATH: '/usr/bin' })
    assert.equal(o.cwd, '/tmp/x')
    assert.deepEqual(o.settingSources, [])
    assert.deepEqual(o.tools, [])
    assert.equal(o.strictMcpConfig, true)
    assert.deepEqual(o.env, { PATH: '/usr/bin' })
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm test -- test/evals/isolation.test.ts`
Expected: FAIL, cannot find module `../../evals/isolation.ts`.

- [ ] **Step 5: Write `evals/isolation.ts`**

```ts
/**
 * The isolation guarantee.
 *
 * Measured, not assumed, in data-fair/agents' lib-sim: with `settingSources: []` but the
 * repository as cwd, the model answered from the project's auto-memory index — naming the
 * very things the harness exists to measure. Auto-memory is keyed to the project
 * directory, so only a neutral cwd removes it. `tools: []` matters as much: without it the
 * SDK offers its own built-ins and the model reaches for those instead of the MCP tools
 * under test.
 *
 * These options are fixed. Nothing in a run may override them.
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export type Env = Record<string, string | undefined>

/** Deliberately meaningless name: the cwd path reaches the model, so it must carry no signal. */
export function neutralCwd (): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'))
}

export function scrubEnv (env: Env): Env {
  const scrubbed: Env = { ...env }
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith('CLAUDE_CODE_')) delete scrubbed[key]
  }
  return scrubbed
}

export function isolationOptions (cwd: string, env: Env = process.env) {
  return {
    cwd,
    env: scrubEnv(env),
    settingSources: [] as never[],
    tools: [] as never[],
    strictMcpConfig: true as const
  }
}
```

- [ ] **Step 6: Run the test, expect PASS; quality; commit**

```bash
npm run quality && git add -A && git commit -m "feat(evals): scenarios, isolation and harness scaffolding

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Arms — configs, tool discovery and provenance

**Files:**
- Create: `evals/arms.ts`, `evals/fixture-server.ts`, `test/evals/arms.test.ts`, `test/evals/fixture-server.test.ts`

**Interfaces:**
- Consumes: `annotateDataFair` from `test/fixtures/data-fair-annotations.ts`.
- Produces:
```ts
export type ArmName = 'A' | 'B'
export interface ArmSpec {
  name: ArmName
  serverName: string                       // the mcpServers key; becomes the tool prefix
  config: { command: string, args: string[], env: Record<string, string> }
  provenance: Record<string, string>
}
export function armA (portalUrl: string, checkoutPath?: string): ArmSpec
export function armB (openapiUrl: string, fixtureHash: string): ArmSpec
export async function discoverTools (arm: ArmSpec): Promise<{ toolNames: string[], allowedTools: string[], definitionBytes: number }>
export function startFixtureServer (): Promise<{ url: string, hash: string, close: () => Promise<void> }>  // from fixture-server.ts
```

`discoverTools` connects a real MCP client over stdio to the arm's server, lists its tools, and returns three things from one connection: the tool names, the `mcp__<serverName>__<name>` strings for `allowedTools`, and the serialized byte size of the tool definitions (the static measurement the spec asks for). Deriving `allowedTools` from discovery rather than a hardcoded list means a renamed tool cannot silently become a denied tool.

- [ ] **Step 1: Write the failing fixture-server test**

`test/evals/fixture-server.test.ts`:
```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { startFixtureServer } from '../../evals/fixture-server.ts'

describe('startFixtureServer', () => {
  it('serves the annotated frozen document and a stable hash', async () => {
    const srv = await startFixtureServer()
    try {
      assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/openapi\.json$/)
      assert.match(srv.hash, /^[0-9a-f]{12}$/)
      const doc: any = await (await fetch(srv.url)).json()
      assert.ok(doc['x-agent'], 'annotations must be merged in')
      assert.equal(doc.servers[0].url, 'https://opendata.koumoul.com/data-fair/api/v1')
      assert.equal(Object.keys(doc.paths).length, 44)
    } finally {
      await srv.close()
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- test/evals/fixture-server.test.ts` — FAIL, cannot find module.

- [ ] **Step 3: Write `evals/fixture-server.ts`**

```ts
/**
 * Serves the frozen data-fair document with the x-agent annotations merged in.
 *
 * The spec under test must be the frozen annotated one — otherwise a run measures whatever
 * the live document said that day — while `servers[0].url` still points at the live
 * instance, so the DATA is live. Port 0: many runs may be in flight across a session.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { annotateDataFair } from '../test/fixtures/data-fair-annotations.ts'

export async function startFixtureServer (): Promise<{ url: string, hash: string, close: () => Promise<void> }> {
  const raw = JSON.parse(await readFile(new URL('../test/fixtures/data-fair-root.json', import.meta.url), 'utf8'))
  const body = JSON.stringify(annotateDataFair(raw))
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12)

  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }

  return {
    url: `http://127.0.0.1:${port}/openapi.json`,
    hash,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}
```

- [ ] **Step 4: Run it, expect PASS**

Run: `npm test -- test/evals/fixture-server.test.ts`

- [ ] **Step 5: Write the failing arms test**

`test/evals/arms.test.ts`:
```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { armA, armB, discoverTools } from '../../evals/arms.ts'
import { startFixtureServer } from '../../evals/fixture-server.ts'

describe('armA', () => {
  it('points at the sibling checkout with stdio transport and records provenance', () => {
    const a = armA('https://opendata.koumoul.com')
    assert.equal(a.name, 'A')
    assert.equal(a.config.command, 'node')
    assert.match(a.config.args[0], /data-fair\/mcp\/index\.ts$/)
    assert.equal(a.config.env.TRANSPORT, 'stdio')
    assert.equal(a.config.env.PORTAL_URL, 'https://opendata.koumoul.com')
    assert.ok(a.provenance.version, 'records the checkout version')
    assert.ok(a.provenance.commit, 'records the checkout commit')
  })
  it('fails loudly naming the path when the checkout is missing', () => {
    assert.throws(() => armA('https://x.example', '/nope/missing'),
      /arm A: data-fair\/mcp checkout not found at \/nope\/missing/)
  })
})

describe('armB', () => {
  it('runs this repo\'s binary against the given spec URL on the explore profile', () => {
    const b = armB('http://127.0.0.1:1234/openapi.json', 'abc123def456')
    assert.equal(b.name, 'B')
    assert.match(b.config.args[0], /src\/bin\/server\.ts$/)
    assert.equal(b.config.env.PROFILE, 'explore')
    assert.equal(b.config.env.OPENAPI_URL, 'http://127.0.0.1:1234/openapi.json')
    assert.equal(b.provenance.fixtureHash, 'abc123def456')
    assert.equal(b.provenance.profile, 'explore')
  })
})

describe('discoverTools', () => {
  it('lists arm B\'s six explore tools, prefixes them, and sizes the definitions', async () => {
    const srv = await startFixtureServer()
    try {
      const d = await discoverTools(armB(srv.url, srv.hash))
      assert.deepEqual(d.toolNames.sort(), ['aggregate_data', 'calculate_metric', 'describe_dataset', 'get_field_values', 'list_datasets', 'search_data'])
      assert.ok(d.allowedTools.every(n => n.startsWith('mcp__datafair__')))
      assert.equal(d.allowedTools.length, 6)
      assert.ok(d.definitionBytes > 5000 && d.definitionBytes < 30000, `definitionBytes was ${d.definitionBytes}`)
    } finally {
      await srv.close()
    }
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- test/evals/arms.test.ts` — FAIL, cannot find module `../../evals/arms.ts`.

- [ ] **Step 7: Write `evals/arms.ts`**

```ts
/**
 * The two arms. They differ in exactly one thing: the MCP server behind them.
 *
 * `allowedTools` is derived from a real tools/list call rather than a hardcoded list,
 * because a hardcoded name that drifts does not fail — it silently becomes a DENIED tool,
 * and a denied tool looks in the transcript like a tool the agent chose not to use.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export type ArmName = 'A' | 'B'

export interface ArmSpec {
  name: ArmName
  serverName: string
  config: { command: string, args: string[], env: Record<string, string> }
  provenance: Record<string, string>
}

/** Both arms register under the same server name, so tool prefixes never identify the arm to the judge. */
const SERVER_NAME = 'datafair'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export function armA (portalUrl: string, checkoutPath = process.env.DATA_FAIR_MCP ?? join(homedir(), 'data-fair/mcp')): ArmSpec {
  const entry = join(checkoutPath, 'index.ts')
  if (!existsSync(entry)) {
    throw new Error(`arm A: data-fair/mcp checkout not found at ${checkoutPath} (set DATA_FAIR_MCP to override)`)
  }
  let version = 'unknown'
  try { version = JSON.parse(readFileSync(join(checkoutPath, 'package.json'), 'utf8')).version } catch { /* recorded as unknown */ }
  let commit = 'unknown'
  try { commit = execFileSync('git', ['-C', checkoutPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* recorded as unknown */ }

  return {
    name: 'A',
    serverName: SERVER_NAME,
    config: { command: 'node', args: [entry], env: { PORTAL_URL: portalUrl, TRANSPORT: 'stdio' } },
    provenance: { source: checkoutPath, version, commit }
  }
}

export function armB (openapiUrl: string, fixtureHash: string): ArmSpec {
  return {
    name: 'B',
    serverName: SERVER_NAME,
    config: {
      command: 'node',
      args: [resolve(repoRoot, 'src/bin/server.ts')],
      env: { OPENAPI_URL: openapiUrl, PROFILE: 'explore' }
    },
    provenance: { fixtureHash, profile: 'explore' }
  }
}

export async function discoverTools (arm: ArmSpec): Promise<{ toolNames: string[], allowedTools: string[], definitionBytes: number }> {
  const transport = new StdioClientTransport({
    command: arm.config.command,
    args: arm.config.args,
    env: { ...process.env, ...arm.config.env } as Record<string, string>
  })
  const client = new Client({ name: 'eval-discovery', version: '0.0.0' })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    const toolNames = tools.map(t => t.name)
    return {
      toolNames,
      allowedTools: toolNames.map(n => `mcp__${arm.serverName}__${n}`),
      definitionBytes: JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).length
    }
  } finally {
    await client.close()
  }
}
```

- [ ] **Step 8: Run the arms test, expect PASS; quality; commit**

If arm A's test fails because `~/data-fair/mcp` is absent on this machine, that is the harness working as designed — report it rather than weakening the assertion.

```bash
npm run quality && git add -A && git commit -m "feat(evals): arm configs, tool discovery and the fixture server

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Transcript extraction

**Files:**
- Create: `evals/transcript.ts`, `test/evals/transcript.test.ts`

**Interfaces:**
- Produces:
```ts
export interface RecordedCall { tool: string, args: unknown, response: string, outputBytes: number, isError: boolean }
export interface RunMetrics { toolCalls: number, toolErrors: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, totalTokens: number, costUsd: number, numTurns: number }
export interface Transcript {
  scenario: string, arm: 'A' | 'B', model: string, startedAt: string,
  provenance: Record<string, string>, question: string,
  calls: RecordedCall[], answer: string, isError: boolean, metrics: RunMetrics
}
export function extractCalls (messages: any[]): RecordedCall[]
export function extractMetrics (result: any, calls: RecordedCall[]): RunMetrics
```

The shapes below were verified by running the real SDK against this repo's binary: `tool_use` blocks arrive on `assistant` messages (`m.message.content`), and their results arrive on the next `user` message as `tool_result` blocks whose `content` is an array of `{ type: 'text', text }`. `totalTokens` sums input + output + cache read + cache creation across every model in `modelUsage` — the SDK's docs say `usage` covers only the main agent loop and to "prefer modelUsage for token/cost accounting".

This task is pure: it is fed message arrays, never a model.

- [ ] **Step 1: Write the failing transcript test**

`test/evals/transcript.test.ts`:
```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractCalls, extractMetrics } from '../../evals/transcript.ts'

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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- test/evals/transcript.test.ts` — FAIL, cannot find module.

- [ ] **Step 3: Write `evals/transcript.ts`**

```ts
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
  arm: 'A' | 'B'
  model: string
  startedAt: string
  provenance: Record<string, string>
  question: string
  calls: RecordedCall[]
  answer: string
  isError: boolean
  metrics: RunMetrics
}

function resultText (content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n')
  }
  return ''
}

export function extractCalls (messages: any[]): RecordedCall[] {
  const calls: RecordedCall[] = []
  let pending: RecordedCall | undefined

  for (const m of messages) {
    if (m?.type === 'assistant') {
      for (const block of m.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue
        pending = {
          tool: String(block.name ?? '').replace(/^mcp__[^_]+__/, ''),
          args: block.input,
          response: '',
          outputBytes: 0,
          isError: false
        }
        calls.push(pending)
      }
    } else if (m?.type === 'user') {
      for (const block of m.message?.content ?? []) {
        if (block?.type !== 'tool_result' || !pending) continue
        pending.response = resultText(block.content)
        pending.outputBytes = pending.response.length
        pending.isError = block.is_error === true
        pending = undefined
      }
    }
  }
  return calls
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
```

- [ ] **Step 4: Run the test, expect PASS; quality; commit**

```bash
npm run quality && git add -A && git commit -m "feat(evals): transcript extraction from the SDK message stream

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The runner

**Files:**
- Create: `evals/run.ts`
- Test: exercised by Task 7's real run; its pure parts are already covered by Tasks 1-3.

**Interfaces:**
- Consumes: `isolationOptions`, `armA`/`armB`/`discoverTools`, `startFixtureServer`, `extractCalls`/`extractMetrics`/`Transcript`.
- Produces: `evals/runs/<scenario>--<arm>.json` (one `Transcript` each) plus `evals/runs/tool-definitions.json` (`{ A: { toolNames, definitionBytes }, B: {...}, measuredAt }`).

CLI: `node evals/run.ts [scenario-id ...]` — all 11 when none named. `--arm A|B` restricts to one arm. `--concurrency N` (default 1).

**This task has no unit test and that is deliberate**: every line of it is either model-driven or already covered. Its verification is Task 7.

- [ ] **Step 1: Write `evals/run.ts`**

```ts
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
import { extractCalls, extractMetrics, type Transcript } from './transcript.ts'

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
    if (argv[i] === '--arm') arm = argv[++i] as 'A' | 'B'
    else if (argv[i] === '--concurrency') concurrency = Number(argv[++i])
    else ids.push(argv[i])
  }
  return { ids, arm, concurrency }
}

async function runOne (scenario: Scenario, arm: ArmSpec, allowedTools: string[]): Promise<Transcript> {
  const cwd = neutralCwd()
  const startedAt = new Date().toISOString()
  const messages: any[] = []
  let result: any = null
  try {
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
    rmSync(cwd, { recursive: true, force: true })
  }

  const calls = extractCalls(messages)
  return {
    scenario: scenario.id,
    arm: arm.name,
    model: MODEL,
    startedAt,
    provenance: arm.provenance,
    question: scenario.question,
    calls,
    answer: result?.result ?? '',
    isError: result?.is_error === true || result == null,
    metrics: extractMetrics(result, calls)
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

  const discovered: Record<string, { toolNames: string[], definitionBytes: number }> = {}
  const allowed: Record<string, string[]> = {}
  for (const a of arms) {
    const d = await discoverTools(a)
    discovered[a.name] = { toolNames: d.toolNames, definitionBytes: d.definitionBytes }
    allowed[a.name] = d.allowedTools
    console.log(`arm ${a.name}: ${d.toolNames.length} tools, ${d.definitionBytes} bytes of definitions`)
  }
  writeFileSync(join(RUNS_DIR, 'tool-definitions.json'),
    JSON.stringify({ ...discovered, measuredAt: new Date().toISOString(), model: MODEL }, null, 2) + '\n')

  const tasks = scenarios.flatMap(s => arms.map(a => async () => {
    const transcript = await runOne(s, a, allowed[a.name])
    writeFileSync(join(RUNS_DIR, `${s.id}--${a.name}.json`), JSON.stringify(transcript, null, 2) + '\n')
    console.log(`${s.id} [${a.name}] ${transcript.isError ? 'ERROR' : 'ok'} — ${transcript.metrics.toolCalls} calls, ${transcript.metrics.totalTokens} tokens, $${transcript.metrics.costUsd.toFixed(4)}`)
    return transcript
  }))
  await pool(tasks, concurrency)
} finally {
  await fixture.close()
}
```

- [ ] **Step 2: Smoke-run ONE scenario on arm B only**

Run: `node evals/run.ts pagination --arm B`
Expected: prints the arm B tool count and definition bytes, then one `pagination [B] ok — N calls, ...` line, and writes `evals/runs/pagination--B.json`.

Open that file and check three things by eye: `calls` is non-empty, each call's `response` holds the markdown the tool returned, and `metrics.totalTokens` is non-zero. If `calls` is empty and the answer mentions permissions, `allowedTools` is not reaching the query — fix that before going on; it is the failure mode this harness is most likely to hit.

- [ ] **Step 3: Quality; commit**

```bash
npm run quality && git add -A && git commit -m "feat(evals): the runner

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Verdict schema and the judge

**Files:**
- Create: `evals/verdict.ts`, `evals/judge.ts`, `test/evals/verdict.test.ts`

**Interfaces:**
- Produces:
```ts
export interface FrictionPoint { call: number, tool: string, observed: string, inferred: string, severity: 'high' | 'medium' | 'low' }
export interface Verdict { scenario: string, verdict: 'satisfactory' | 'unsatisfactory', reasoning: string, friction: FrictionPoint[] }
export function parseVerdict (text: string): Verdict
```
- `judge.ts` writes `evals/runs/<scenario>--<arm>.verdict.json` holding `{ ...Verdict, judgeModel, judgedAt }`.

The judge is a language model, so its output is untrusted text. Validating here means a malformed verdict fails at parse time rather than silently producing an empty friction list that reads as "no problems found".

- [ ] **Step 1: Write the failing verdict test**

`test/evals/verdict.test.ts`:
```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- test/evals/verdict.test.ts` — FAIL, cannot find module.

- [ ] **Step 3: Write `evals/verdict.ts`**

```ts
/**
 * Parse and validate a judge's verdict.
 *
 * The judge is a language model, so its answer is untrusted text. Validating here means a
 * malformed verdict fails loudly at parse time rather than silently producing an empty
 * friction list that reads as "no problems found".
 */

export interface FrictionPoint {
  call: number
  tool: string
  observed: string
  inferred: string
  severity: 'high' | 'medium' | 'low'
}

export interface Verdict {
  scenario: string
  verdict: 'satisfactory' | 'unsatisfactory'
  reasoning: string
  friction: FrictionPoint[]
}

const VERDICTS = ['satisfactory', 'unsatisfactory']
const SEVERITIES = ['high', 'medium', 'low']

export function parseVerdict (text: string): Verdict {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const raw = (fenced ? fenced[1] : text).trim()

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`the judge's answer could not be parsed as JSON: ${raw.slice(0, 200)}`)
  }

  if (typeof parsed?.scenario !== 'string') throw new Error('verdict.scenario must be the scenario id')
  if (!VERDICTS.includes(parsed.verdict)) {
    throw new Error(`verdict must be one of ${VERDICTS.join(', ')}, got ${JSON.stringify(parsed.verdict)}`)
  }
  if (typeof parsed.reasoning !== 'string' || !parsed.reasoning.trim()) {
    throw new Error('verdict.reasoning must explain the verdict')
  }
  if (!Array.isArray(parsed.friction)) throw new Error('verdict.friction must be an array')

  for (const [i, point] of parsed.friction.entries()) {
    // Anchoring is what makes a friction point actionable: without a call number nobody
    // can find the response that misled the agent. 1-based, so 0 is rejected too.
    if (!Number.isInteger(point?.call) || point.call < 1) {
      throw new Error(`friction[${i}].call must be the 1-based call number`)
    }
    if (typeof point.tool !== 'string') throw new Error(`friction[${i}].tool must name the tool`)
    if (typeof point.observed !== 'string') throw new Error(`friction[${i}].observed must quote what the tool returned`)
    if (typeof point.inferred !== 'string') throw new Error(`friction[${i}].inferred must say what the agent apparently concluded`)
    if (!SEVERITIES.includes(point.severity)) {
      throw new Error(`friction[${i}].severity must be one of ${SEVERITIES.join(', ')}`)
    }
  }

  return parsed as Verdict
}
```

- [ ] **Step 4: Run the verdict test, expect PASS**

- [ ] **Step 5: Write `evals/judge.ts`**

```ts
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
 */
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { isolationOptions, neutralCwd } from './isolation.ts'
import { parseVerdict } from './verdict.ts'
import type { Transcript } from './transcript.ts'

const JUDGE_MODEL = process.env.OPENAPI_MCP_EVAL_JUDGE_MODEL ?? 'sonnet'
const here = fileURLToPath(new URL('.', import.meta.url))
const RUNS_DIR = join(here, 'runs')

interface Scenario { id: string, question: string, expected: string }
const scenarios: Scenario[] = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8'))

function prompt (t: Transcript, expected: string): string {
  const calls = t.calls.map((c, i) => [
    `### Call ${i + 1}: ${c.tool}${c.isError ? ' (returned an error)' : ''}`,
    `Arguments: ${JSON.stringify(c.args)}`,
    'Returned:',
    '```',
    c.response.length > 4000 ? c.response.slice(0, 4000) + '\n…(truncated)' : c.response,
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

async function ask (text: string): Promise<string> {
  const cwd = neutralCwd()
  try {
    let answer = ''
    for await (const m of query({ prompt: text, options: { ...isolationOptions(cwd), model: JUDGE_MODEL } })) {
      if (m.type === 'result') answer = (m as any).result ?? ''
    }
    return answer
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

const only = process.argv.slice(2)
const files = readdirSync(RUNS_DIR)
  .filter(f => f.endsWith('.json') && !f.endsWith('.verdict.json') && f !== 'tool-definitions.json')
  .filter(f => !only.length || only.some(o => f.startsWith(o)))

if (!files.length) throw new Error(`no transcripts to judge in ${RUNS_DIR} — run eval:run first`)

for (const file of files) {
  const transcript: Transcript = JSON.parse(readFileSync(join(RUNS_DIR, file), 'utf8'))
  const expected = scenarios.find(s => s.id === transcript.scenario)?.expected
  if (!expected) throw new Error(`${file}: no scenario named ${transcript.scenario}`)

  const answer = await ask(prompt(transcript, expected))
  const verdict = parseVerdict(answer)
  if (verdict.scenario !== transcript.scenario) {
    throw new Error(`${file}: judge answered for scenario ${verdict.scenario}`)
  }
  writeFileSync(join(RUNS_DIR, file.replace(/\.json$/, '.verdict.json')),
    JSON.stringify({ ...verdict, judgeModel: JUDGE_MODEL, judgedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(`${file}: ${verdict.verdict}${verdict.friction.length ? ` (${verdict.friction.length} friction)` : ''}`)
}
```

- [ ] **Step 6: Judge the one transcript from Task 4**

Run: `node evals/judge.ts pagination`
Expected: one line `pagination--B.json: satisfactory` (or `unsatisfactory` with friction), and a `pagination--B.verdict.json` beside it. Read the verdict: the reasoning should be about what the agent did, and any friction point should name a real call number.

- [ ] **Step 7: Quality; commit**

```bash
npm run quality && git add -A && git commit -m "feat(evals): verdict schema and the judge

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The report

**Files:**
- Create: `evals/report.ts`, `test/evals/report.test.ts`

**Interfaces:**
- Consumes: `Transcript`, `Verdict`.
- Produces: `export function summarise (runs: Run[], toolDefs: ToolDefs | null): { lines: string[], failed: boolean }` where
```ts
export interface Run { scenario: string, arm: 'A' | 'B', transcript: Transcript | null, verdict: Verdict | null }
export interface ToolDefs { A?: { toolNames: string[], definitionBytes: number }, B?: { toolNames: string[], definitionBytes: number } }
```
`summarise` is pure so it can be tested without a model. The CLI reads `evals/runs/`, calls it, prints the lines, and exits 1 when `failed`.

Rules: a run with no transcript is a failure (a scenario that never dispatched must fail loudly, not disappear). A run with no verdict is a failure (a transcript nobody read is not evidence). The B/A token ratio is reported against 1.2, and exceeding it is reported but does NOT fail the report — the ratio is the spec's criterion for the project, not a test threshold.

- [ ] **Step 1: Write the failing report test**

`test/evals/report.test.ts`:
```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarise, type Run } from '../../evals/report.ts'

const t = (scenario: string, arm: 'A' | 'B', totalTokens: number, toolCalls = 2, toolErrors = 0) => ({
  scenario, arm, model: 'haiku', startedAt: '2026-09-20T10:00:00.000Z', provenance: {}, question: 'q',
  calls: [], answer: 'a', isError: false,
  metrics: { toolCalls, toolErrors, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens, costUsd: 0.01, numTurns: 2 }
}) as any

const v = (scenario: string, verdict: 'satisfactory' | 'unsatisfactory', friction = 0) => ({
  scenario, verdict, reasoning: 'r',
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
    assert.match(lines.join('\n'), /s1 \[B\].*never ran/)
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
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- test/evals/report.test.ts` — FAIL, cannot find module.

- [ ] **Step 3: Write `evals/report.ts`**

```ts
#!/usr/bin/env node
/**
 * Summarise a judged run.
 *
 * Deliberately has almost no thresholds: the numbers are context and the verdict is the
 * judge's. The one criterion that IS reported against a number is the spec's B/A token
 * ratio — and even that only prints "over", because it is the project's question, not a
 * test that should fail a command.
 *
 * What does fail the report: a run that never dispatched, and a transcript nobody judged.
 * A scenario that quietly disappears from a table is worse than one that fails in it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Transcript } from './transcript.ts'
import type { Verdict } from './verdict.ts'

export interface Run { scenario: string, arm: 'A' | 'B', transcript: Transcript | null, verdict: Verdict | null }
export interface ToolDefs { A?: { toolNames: string[], definitionBytes: number }, B?: { toolNames: string[], definitionBytes: number } }

const TOKEN_RATIO_CRITERION = 1.2

export function summarise (runs: Run[], toolDefs: ToolDefs | null): { lines: string[], failed: boolean } {
  const lines: string[] = []
  let failed = false

  lines.push('| scenario | arm | verdict | calls | errors | friction | tokens | cost |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')

  for (const run of [...runs].sort((a, b) => a.scenario.localeCompare(b.scenario) || a.arm.localeCompare(b.arm))) {
    if (!run.transcript) {
      failed = true
      lines.push(`| ${run.scenario} | ${run.arm} | **never ran** | - | - | - | - | - |`)
      continue
    }
    const m = run.transcript.metrics
    if (!run.verdict) {
      failed = true
      lines.push(`| ${run.scenario} | ${run.arm} | **not judged** | ${m.toolCalls} | ${m.toolErrors} | - | ${m.totalTokens} | $${m.costUsd.toFixed(4)} |`)
      continue
    }
    const mark = run.verdict.verdict === 'satisfactory' ? 'pass' : '**fail**'
    lines.push(`| ${run.scenario} | ${run.arm} | ${mark} | ${m.toolCalls} | ${m.toolErrors} | ${run.verdict.friction.length} | ${m.totalTokens} | $${m.costUsd.toFixed(4)} |`)
  }

  const byArm = (arm: 'A' | 'B') => runs.filter(r => r.arm === arm)
  const tokens = (arm: 'A' | 'B') => byArm(arm).reduce((n, r) => n + (r.transcript?.metrics.totalTokens ?? 0), 0)
  const friction = (arm: 'A' | 'B') => byArm(arm).reduce((n, r) => n + (r.verdict?.friction.length ?? 0), 0)
  const passes = (arm: 'A' | 'B') => byArm(arm).filter(r => r.verdict?.verdict === 'satisfactory').length

  lines.push('')
  for (const arm of ['A', 'B'] as const) {
    if (byArm(arm).length) lines.push(`arm ${arm}: ${passes(arm)}/${byArm(arm).length} satisfactory, ${tokens(arm)} tokens`)
  }
  lines.push(`friction points: A ${friction('A')}, B ${friction('B')}`)

  const ta = tokens('A'); const tb = tokens('B')
  if (ta > 0 && tb > 0) {
    const ratio = tb / ta
    lines.push(`B/A token ratio: ${ratio.toFixed(2)} (criterion: ≤ ${TOKEN_RATIO_CRITERION}${ratio > TOKEN_RATIO_CRITERION ? ' — over' : ''})`)
  }
  if (toolDefs?.A || toolDefs?.B) {
    const size = (arm: 'A' | 'B') => toolDefs?.[arm] ? `${toolDefs[arm]!.toolNames.length} tools, ${toolDefs[arm]!.definitionBytes} bytes` : 'not measured'
    lines.push(`tool definitions: A ${size('A')}; B ${size('B')}`)
  }

  return { lines, failed }
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const RUNS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'runs')
  if (!existsSync(RUNS_DIR)) throw new Error(`no runs directory at ${RUNS_DIR} — run eval:run first`)

  const runs: Run[] = readdirSync(RUNS_DIR)
    .filter(f => f.endsWith('.json') && !f.endsWith('.verdict.json') && f !== 'tool-definitions.json')
    .map(file => {
      const transcript: Transcript = JSON.parse(readFileSync(join(RUNS_DIR, file), 'utf8'))
      const verdictPath = join(RUNS_DIR, file.replace(/\.json$/, '.verdict.json'))
      return {
        scenario: transcript.scenario,
        arm: transcript.arm,
        transcript,
        verdict: existsSync(verdictPath) ? JSON.parse(readFileSync(verdictPath, 'utf8')) : null
      }
    })

  const defsPath = join(RUNS_DIR, 'tool-definitions.json')
  const toolDefs: ToolDefs | null = existsSync(defsPath) ? JSON.parse(readFileSync(defsPath, 'utf8')) : null

  const { lines, failed } = summarise(runs, toolDefs)
  console.log(lines.join('\n'))
  if (failed) process.exit(1)
}
```

- [ ] **Step 4: Run the report test, expect PASS; then run the CLI on what exists**

Run: `npm test -- test/evals/report.test.ts` then `node evals/report.ts`
Expected: a one-row table for the `pagination` run from Tasks 4-5, plus the arm-B totals. With only one arm present there is no ratio line, which is correct.

- [ ] **Step 5: Quality; commit**

```bash
npm run quality && git add -A && git commit -m "feat(evals): the report

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The first full run, the baseline and the findings

**Files:**
- Create: `evals/baselines/<today>/` (transcripts, verdicts, `tool-definitions.json`, `report.md`)
- Modify: `docs/superpowers/specs/2026-09-19-eval-harness-design.md` (append `## First run`)
- Modify: `README.md` (one short section on running the eval)

This task is the deliverable. Tasks 1-6 built the instrument; this one takes the measurement and writes down what it says.

**Before starting, confirm the cost is expected.** 22 runs on the runner model plus 22 judgments on the judge model. A comparable suite in a sibling project cost about $0.25 for six cases on haiku; this is roughly four times the cases plus judging, so expect low single-digit dollars. If a run errors, that is a datum — do not silently re-run it to get a nicer table.

- [ ] **Step 1: Verify arm A can start at all**

Run: `node evals/run.ts pagination --arm A`
Expected: arm A's tool count and definition bytes print, then one `pagination [A] ok` line.

If `~/data-fair/mcp` is missing, the harness fails loudly naming the path — report that to the controller rather than skipping arm A, because a report with one arm cannot answer the question this phase exists to ask.

- [ ] **Step 2: Run the full suite**

```bash
rm -rf evals/runs && npm run eval:run 2>&1 | tee /tmp/eval-run.log
```
Expected: two tool-definition lines, then 22 result lines. Note any `ERROR` lines — they stay in the results.

- [ ] **Step 3: Judge every transcript**

```bash
npm run eval:judge 2>&1 | tee /tmp/eval-judge.log
```
If `parseVerdict` throws on some transcript, that is the validator doing its job: re-run `node evals/judge.ts <scenario>` for that one. If it throws repeatedly on the same transcript, record it in your report as a judging failure rather than hand-editing a verdict file.

- [ ] **Step 4: Produce the report**

```bash
npm run eval:report | tee /tmp/eval-report.md
```

- [ ] **Step 5: Read the friction points before the ratio**

Collect every friction point across both arms:
```bash
node -e "
const fs=require('fs'),p='evals/runs'
for (const f of fs.readdirSync(p).filter(f=>f.endsWith('.verdict.json'))) {
  const v=JSON.parse(fs.readFileSync(p+'/'+f,'utf8'))
  for (const x of v.friction) console.log([f.replace('.verdict.json',''), x.severity, x.tool, 'call '+x.call, x.observed.slice(0,90).replace(/\n/g,' '), '->', x.inferred.slice(0,90)].join(' | '))
}"
```
Group them: which are about a tool description that promised something the schema rejected, which about a response that misled, which about information the agent had to fetch twice. That grouping is the finding — the ratio is one number, the friction is the diagnosis.

- [ ] **Step 6: Save the baseline**

```bash
D=$(date +%F) && mkdir -p evals/baselines/$D && cp evals/runs/*.json evals/baselines/$D/ && cp /tmp/eval-report.md evals/baselines/$D/report.md && ls evals/baselines/$D | wc -l
```

- [ ] **Step 7: Append `## First run` to the eval spec**

Write, in the spec, with real numbers from this run and no rounding in your favour:
- the date, the runner and judge models, and both arms' provenance;
- the table from `report.md`;
- pass rate per arm, the B/A token ratio against 1.2, and the two tool-definition sizes;
- **the friction findings, grouped**, with the call each is anchored to;
- a plain-language answer to the phase-1 question: *can annotations alone match the hand-written tools?* — with its qualifications. If B passed on the ratio but the friction shows the interaction is worse, say exactly that: the ratio is one criterion and the spec's own design warned it may be the wrong one.
- anything the run revealed that neither the parity list nor this plan anticipated.

- [ ] **Step 8: Add a short README section**

Under a `## Evaluating` heading: what the harness compares, the four npm scripts, the two model env vars and their defaults, that `DATA_FAIR_MCP` points at the sibling checkout, that it costs money and hits a live public instance, and a pointer to the newest baseline. Do not restate the design — link the spec.

- [ ] **Step 9: Quality; commit**

```bash
npm run quality && git add -A && git commit -m "test(evals): first full parity run and baseline

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done when

- `npm run quality` is green and the eval unit tests pass without touching a model.
- `evals/baselines/<date>/` holds 22 transcripts, 22 verdicts, `tool-definitions.json` and `report.md`.
- The eval spec's `## First run` section answers the phase-1 question with numbers, qualifications, and grouped friction findings — which is phase 3's input, the way the parity gap list was phase 2's.
