# Stack composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose the service-level OpenAPI documents listed by a deployment index into one live, profile-selected tool set, carry the caller's identity per call, and serve it over MCP SDK v2 with the skills extension — this repository's share (roadmap step 1) of the stack composition design.

**Architecture:** Profiles become sets selected per request, with `includes` for supersets. `Tool.execute` gains a per-call `CallContext` (fetch, headers, signal, identity) so a shared HTTP server can serve many callers and editor sessions are partitioned by caller. A `Composer` holds one document cache for an index and hands out memoized `Composition`s per profile set, refreshing with conditional GETs on the caller's schedule. The MCP adapter is rewritten on `@modelcontextprotocol/server` 2.0 as a per-request factory (both protocol eras), serving skills as `skill://` resources through `io.modelcontextprotocol/skills`.

**Tech Stack:** TypeScript on Node 24 (native type stripping, no build step for tests), `node:test` + `node:assert/strict`, Ajv 8, `@modelcontextprotocol/server` 2.0.0 + `@modelcontextprotocol/node` 2.0.0 (runtime), `@modelcontextprotocol/client` 2.0.0 + `zod` 4 (tests and evals), `@json-layout/agents` (optional peer, lazily imported, unchanged).

**Spec:** `docs/superpowers/specs/2026-09-22-stack-composition-design.md`

## Global Constraints

- Node `>=24`, ESM, tests run TypeScript directly. `npm run quality` (eslint + `tsc` + `node --test`) is green before every commit.
- Dependencies after Task 7: `@modelcontextprotocol/server ^2.0.0` and `@modelcontextprotocol/node ^2.0.0` in `dependencies`; `@modelcontextprotocol/client ^2.0.0` and `zod ^4.2.0` in `devDependencies`; `@modelcontextprotocol/sdk` removed everywhere.
- The library **never runs a timer**, **never reads a cookie**, **never holds a credential**. `refresh()` is called by the server; identity is produced by the server's context hook or the environment.
- `Tool.execute` **never throws**; every failure is `{ isError: true, text }`.
- `@json-layout/agents` and `@json-layout/core` stay optional peers, imported lazily inside functions only.
- Skill names match `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters. Skill URI is `skill://<id>/SKILL.md`; digest is `sha256:` + 64 lowercase hex of the file's UTF-8 bytes; size is that byte length.
- Skills extension identifier: `io.modelcontextprotocol/skills`, declared in `capabilities.extensions` next to `resources`. `directoryRead` is not declared (false). Unknown skill or resource URI → JSON-RPC error `-32602`.
- Tool order is deterministic: index order, then document order. `tools/list`, `resources/list`, `resources/read`, `server/discover` and the two `skills/*` results carry `ttlMs` = `refreshMs` (default `300000`) and `cacheScope: 'private'`.
- Index `version` is `1`; service `id` matches `^[a-z0-9-]+$` and is unique. On a tool-name collision the **later** service in index order is excluded.
- Editor session key: `${identity ?? ''}:${op.toolName}:${path values in declared order joined by ':'}`. A session's HTTP calls use the context of the call in progress, never one captured at creation.
- Profile set selection: an operation is selected when its (expanded) labels intersect the requested set; an empty request means the default profile. Document-level `includes` naming an undeclared profile, or forming a cycle, refuses the document at `load()`.

---

## File Structure

**Created:**
- `src/profiles.ts` — `includes` expansion, cycle/undeclared detection, set selection. No I/O.
- `src/context.ts` — `callFetch` (apply a `CallContext` to a `Request` and pick the fetch) and `currentCall` (an `AsyncLocalStorage` so editor sessions see the context of the call in progress).
- `src/skills.ts` — `Skill` objects from a document's `x-agent.skills`, and `renderSkillFile` (SKILL.md text, frontmatter, digest, size).
- `src/snapshot.ts` — `toolSetSnapshot`, the stable JSON a per-service golden diffs.
- `src/index-contract.ts` — the index type, its JSON Schema, `validateIndex`.
- `src/compose.ts` — `createComposer`, `compose`, `Composer`, `Composition`, `ServiceStatus`, `ProfileInfo`. Document cache, profile-set selection, merge, refresh, change notification.
- `test/profiles.test.ts`, `test/context.test.ts`, `test/skills.test.ts`, `test/snapshot.test.ts`, `test/index-contract.test.ts`, `test/compose.test.ts`
- `test/fixtures/vetstore.json` — a second annotated service with its own prefix and an `includes` superset.

**Modified:**
- `src/types.ts` — `CallContext`, `Skill`, `Tool.execute(params, ctx?)`, `ToolSet.profiles` + `ToolSet.skills`, `includes` on root profiles.
- `src/vocabulary/schema.ts` — `includes`; skill name rule.
- `src/spec.ts` — `resolveOperations(doc, profiles)` over a set; `loadSpec` expands profiles to fail early.
- `src/load.ts` — `profiles` option, per-call context in `execute`, skills, contextual fetch for editors.
- `src/editor/bridge.ts`, `src/editor/index.ts` — identity-keyed sessions, context of the call in progress.
- `src/adapters/mcp.ts` — rewritten on SDK v2: factory, both eras, cache hints, skills extension, per-request profiles and context.
- `src/bin/server.ts` — `INDEX_URL` | `OPENAPI_URL`, `PROFILES`, `REFRESH_INTERVAL`, `LINT`, `serveStdio`, `createMcpHandler` + `toNodeHandler`.
- `src/index.ts` — new exports.
- `evals/arms.ts`, `evals/run.ts`, `evals/fixture-server.ts` — client package swap; arm C over an index.
- `test/adapters-mcp.test.ts` (rewritten), `test/bin.test.ts`, `test/load.test.ts`, `test/spec.test.ts`, `test/vocabulary.test.ts`, `test/editor-group.test.ts`, `test/fixtures/data-fair-annotations.ts`, `test/evals/arms.test.ts`
- `package.json`, `README.md`, `CONTRIBUTING.md`, `docs/x-agent.md`, `skills/openapi-mcp/SKILL.md`

---

### Task 1: Profile `includes` and the skill-name rule

**Files:**
- Modify: `src/types.ts:79-83` (`AgentRoot`)
- Modify: `src/vocabulary/schema.ts:33-48` (`rootSchema`)
- Modify: `src/spec.ts:55-66` (`loadSpec`)
- Modify: `test/fixtures/data-fair-annotations.ts:19` (`Workflow` → `workflow`)
- Create: `src/profiles.ts`
- Test: `test/vocabulary.test.ts`, `test/profiles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // src/profiles.ts
  export type ProfileDeclarations = Record<string, { title?: Localized, description?: Localized, includes?: string[] }>
  export function expandProfiles (declared: ProfileDeclarations | undefined, extra?: Record<string, { includes?: string[] }>): Map<string, Set<string>>
  export function selectProfiles (requested: string[], expanded: Map<string, Set<string>>): Set<string>
  export function matchesProfiles (profiles: string[] | true, selected: Set<string>): boolean
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/profiles.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { expandProfiles, selectProfiles, matchesProfiles } from '../src/profiles.ts'

describe('profiles', () => {
  it('expands includes transitively, each profile selecting itself', () => {
    const expanded = expandProfiles({
      explore: {},
      edit_datasets: {},
      edit_applications: {},
      edit: { includes: ['edit_datasets', 'edit_applications'] },
      full: { includes: ['explore', 'edit'] }
    })
    assert.deepEqual([...expanded.get('explore')!], ['explore'])
    assert.deepEqual([...expanded.get('edit')!].sort(), ['edit', 'edit_applications', 'edit_datasets'])
    assert.deepEqual([...expanded.get('full')!].sort(), ['edit', 'edit_applications', 'edit_datasets', 'explore', 'full'])
  })
  it('refuses a cycle', () => {
    assert.throws(() => expandProfiles({ a: { includes: ['b'] }, b: { includes: ['a'] } }), /cycle: a → b → a/)
  })
  it('refuses an include naming an undeclared profile', () => {
    assert.throws(() => expandProfiles({ edit: { includes: ['nope'] } }), /profile "edit" includes "nope", which is not declared/)
  })
  it('lets index-level includes reach profiles a document does not declare, without error', () => {
    const expanded = expandProfiles({ explore: {} }, { full: { includes: ['explore', 'admin'] } })
    assert.deepEqual([...expanded.get('full')!].sort(), ['admin', 'explore', 'full'])
  })
  it('selects the union of the requested expansions, unknown names selecting themselves', () => {
    const expanded = expandProfiles({ explore: {}, edit: { includes: ['explore'] } })
    assert.deepEqual([...selectProfiles(['edit', 'other'], expanded)].sort(), ['edit', 'explore', 'other'])
  })
  it('matches an operation whose labels intersect the selection, or carries true', () => {
    const selected = new Set(['explore'])
    assert.equal(matchesProfiles(['explore', 'edit'], selected), true)
    assert.equal(matchesProfiles(['edit'], selected), false)
    assert.equal(matchesProfiles(true, selected), true)
  })
})
```

Add to `test/vocabulary.test.ts`, inside `describe('validateVocabulary', …)` (the file's `doc()` helper builds a document from a patch):

```ts
  it('accepts includes on a root profile', () => {
    assert.doesNotThrow(() => validateVocabulary(doc({ 'x-agent': { profiles: { a: {}, b: { includes: ['a'] } } } })))
  })
  it('rejects a skill name outside the Agent Skills format', () => {
    assert.throws(() => validateVocabulary(doc({ 'x-agent': { skills: [{ name: 'Workflow', description: 'd' }] } })), /x-agent invalid at \/: \/skills\/0\/name must match pattern/)
    assert.doesNotThrow(() => validateVocabulary(doc({ 'x-agent': { skills: [{ name: 'publishing-workflow', description: 'd' }] } })))
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/profiles.test.ts test/vocabulary.test.ts`
Expected: `profiles.test.ts` fails to import (`src/profiles.ts` does not exist); the two new vocabulary cases fail (`includes` is an unknown property; `Workflow` is accepted).

- [ ] **Step 3: Implement**

`src/types.ts` — replace the `profiles` line of `AgentRoot`:

```ts
export interface AgentRoot {
  namePrefix?: string
  /** `includes` declares a superset: requesting this profile also selects every operation of the included ones. */
  profiles?: Record<string, { title?: Localized, description?: Localized, includes?: string[] }>
  skills?: AgentSkill[]
}
```

`src/vocabulary/schema.ts` — in `rootSchema.properties`:

```ts
    profiles: {
      type: 'object',
      minProperties: 1,
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: { title: localized, description: localized, includes: { type: 'array', items: { type: 'string' }, minItems: 1 } }
      }
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: {
          // The MCP skills extension requires `name` to equal the last URI segment and
          // delegates its format to the Agent Skills specification.
          name: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 },
          description: localized,
          profiles: { type: 'array', items: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' } }
        }
      }
    }
```

Create `src/profiles.ts`:

```ts
import type { Localized } from './types.ts'

export type ProfileDeclarations = Record<string, { title?: Localized, description?: Localized, includes?: string[] }>

/**
 * Every profile name → the set of profiles it selects: itself and, transitively, what it
 * includes. `declared` is a document's own map, checked strictly: an include must name a
 * declared profile and must not form a cycle. `extra` is an index's map, whose includes may
 * reach names this document never declares (a stack-wide `full` including `admin` on a
 * service without admin operations selects nothing there, which is not an error).
 */
export function expandProfiles (declared: ProfileDeclarations | undefined, extra?: Record<string, { includes?: string[] }>): Map<string, Set<string>> {
  const includes = new Map<string, string[]>()
  for (const [name, p] of Object.entries(extra ?? {})) includes.set(name, [...(p.includes ?? [])])
  for (const [name, p] of Object.entries(declared ?? {})) {
    for (const inc of p.includes ?? []) {
      if (!(inc in declared!)) throw new Error(`profile "${name}" includes "${inc}", which is not declared`)
    }
    includes.set(name, [...(includes.get(name) ?? []), ...(p.includes ?? [])])
  }
  const out = new Map<string, Set<string>>()
  const expand = (name: string, trail: string[]): Set<string> => {
    const done = out.get(name)
    if (done) return done
    if (trail.includes(name)) throw new Error(`profile includes form a cycle: ${[...trail, name].join(' → ')}`)
    const set = new Set([name])
    for (const inc of includes.get(name) ?? []) for (const n of expand(inc, [...trail, name])) set.add(n)
    out.set(name, set)
    return set
  }
  for (const name of includes.keys()) expand(name, [])
  return out
}

/** The union of the requested profiles' expansions. A name nothing declares selects itself. */
export function selectProfiles (requested: string[], expanded: Map<string, Set<string>>): Set<string> {
  const set = new Set<string>()
  for (const r of requested) for (const n of expanded.get(r) ?? [r]) set.add(n)
  return set
}

export function matchesProfiles (profiles: string[] | true, selected: Set<string>): boolean {
  return profiles === true || profiles.some(p => selected.has(p))
}
```

`src/spec.ts` — import and fail early in `loadSpec`, after `validateVocabulary(doc)`:

```ts
import { expandProfiles } from './profiles.ts'
// …
  validateVocabulary(doc)
  expandProfiles((doc['x-agent'] as AgentRoot | undefined)?.profiles)
  return inlineRefs(doc)
```

`test/fixtures/data-fair-annotations.ts:19` — `name: 'Workflow'` → `name: 'workflow'`. Then run `grep -rn "## Workflow" test evals` and change any golden or assertion that names the section to `## workflow`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run quality`
Expected: all green, including the existing `data-fair.test.ts` (the renamed skill).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/vocabulary/schema.ts src/spec.ts src/profiles.ts test/profiles.test.ts test/vocabulary.test.ts test/fixtures/data-fair-annotations.ts
git commit -m "feat: profile includes and the Agent Skills name rule"
```

---

### Task 2: Profile sets in `resolveOperations` and `load`

**Files:**
- Modify: `src/spec.ts:117-146` (`resolveOperations`)
- Modify: `src/load.ts:31-46` (`buildInstructions`), `src/load.ts:113-160` (`load`), `LoadOptions`
- Modify: `src/types.ts:129-133` (`ToolSet`)
- Modify: `src/bin/server.ts:56,60` (log lines only)
- Test: `test/spec.test.ts`, `test/load.test.ts`

**Interfaces:**
- Consumes: `expandProfiles`, `selectProfiles`, `matchesProfiles` (Task 1).
- Produces:
  ```ts
  export function resolveOperations (doc: JsonSchema, profiles: string | string[], overrides?: { namePrefix?: string }): ResolvedOperation[]
  export interface LoadOptions { profile?: string; profiles?: string[]; namePrefix?: string; /* …unchanged… */ }
  export interface ToolSet { profiles: string[]; instructions: string; tools: Tool[] }   // `skills` is added in Task 4
  export function buildInstructions (doc: JsonSchema, profiles: string[], ops: ResolvedOperation[], locale: string): string
  ```

- [ ] **Step 1: Write the failing tests**

In `test/spec.test.ts`, inside the existing `describe` for `resolveOperations`, add:

```ts
  it('selects a set of profiles, each operation once, honouring includes', () => {
    const d = inlineRefs({
      ...petstore,
      'x-agent': { ...petstore['x-agent'], profiles: { explore: {}, edit: { includes: ['explore'] } } }
    })
    const both = resolveOperations(d, ['explore', 'edit']).map(o => o.toolName)
    assert.deepEqual(both, ['pets_list_pets', 'pets_create_pet', 'pets_get_pet'])
    const viaInclude = resolveOperations(d, ['edit']).map(o => o.toolName)
    assert.deepEqual(viaInclude, ['pets_list_pets', 'pets_create_pet', 'pets_get_pet'])
  })
  it('lets the caller override the name prefix — a legacy route serving unprefixed names', () => {
    assert.deepEqual(resolveOperations(inlineRefs(petstore), 'explore', { namePrefix: '' }).map(o => o.toolName), ['list_pets', 'get_pet'])
    assert.deepEqual(resolveOperations(inlineRefs(petstore), 'explore', { namePrefix: 'legacy_' }).map(o => o.toolName), ['legacy_list_pets', 'legacy_get_pet'])
  })
```

(`petstore` and `inlineRefs` are already imported at the top of that file; `listPets` and `getPet` carry the `Pets` tag whose profiles are `['explore']`, `createPet` carries `['edit']`.)

In `test/load.test.ts`:
- line 23: `assert.equal(ts.profile, 'explore')` → `assert.deepEqual(ts.profiles, ['explore'])`
- add:

```ts
  it('loads a set of profiles and records it', async () => {
    const ts = await load(petstore, { profiles: ['explore', 'edit'], fetch: stub(() => json({})).fetchFn })
    assert.deepEqual(ts.profiles, ['explore', 'edit'])
    assert.deepEqual(ts.tools.map(t => t.name), ['pets_list_pets', 'pets_create_pet', 'pets_get_pet'])
    assert.match(ts.instructions, /## editing/)
  })
  it('rejects a set naming an undeclared profile', async () => {
    await assert.rejects(load(petstore, { profiles: ['explore', 'nope'] }), /unknown profile "nope" \(declared: explore, edit\)/)
  })
  it('applies a name prefix override', async () => {
    const ts = await load(petstore, { namePrefix: '', fetch: stub(() => json({})).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['list_pets', 'get_pet'])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/spec.test.ts test/load.test.ts`
Expected: the new cases fail (`resolveOperations` ignores an array; `ts.profiles` is undefined; `profiles` option is not read).

- [ ] **Step 3: Implement**

`src/spec.ts` — replace `profilesInclude` and the body of `resolveOperations`:

```ts
import { expandProfiles, selectProfiles, matchesProfiles } from './profiles.ts'
// delete the profilesInclude helper

export function resolveOperations (doc: JsonSchema, profiles: string | string[], overrides: { namePrefix?: string } = {}): ResolvedOperation[] {
  const root: AgentRoot = doc['x-agent'] ?? {}
  // A caller may replace the document's prefix: a route kept for compatibility serves the
  // same operations under the names its clients already have in their allow-lists.
  const prefix = overrides.namePrefix ?? root.namePrefix ?? ''
  const requested = Array.isArray(profiles) ? profiles : [profiles]
  const selected = selectProfiles(requested, expandProfiles(root.profiles))
  const tagAgents = new Map<string, AgentTag>()
  for (const t of doc.tags ?? []) if (t?.['x-agent']) tagAgents.set(t.name, t['x-agent'])

  const out: ResolvedOperation[] = []
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op || op['x-agent'] === undefined) continue
      const agent: AgentOperation = op['x-agent']
      const tags: string[] = op.tags ?? []
      const tagProfiles = tags.map(t => tagAgents.get(t)?.profiles).find(p => p !== undefined)
      const opProfiles = agent.profiles ?? tagProfiles ?? true
      if (!matchesProfiles(opProfiles, selected)) continue
      if (!op.operationId) throw new Error(`operation ${method.toUpperCase()} ${path} has x-agent but no operationId`)
      out.push(resolveOne(path, item, method, op, agent, opProfiles, prefix))
    }
  }
  const dupes = out.map(o => o.toolName).filter((n, i, a) => a.indexOf(n) !== i)
  if (dupes.length) throw new Error(`duplicate tool names: ${[...new Set(dupes)].join(', ')}`)
  return out
}
```

`src/types.ts` — `ToolSet`:

```ts
export interface ToolSet {
  /** the profiles requested, in request order */
  profiles: string[]
  instructions: string
  tools: Tool[]
}
```

`src/load.ts`:

```ts
import { expandProfiles, selectProfiles } from './profiles.ts'

export interface LoadOptions {
  /** one profile; `profiles` wins when both are given */
  profile?: string
  /** a set of profiles; an operation in any of them (after `includes` expansion) is selected once */
  profiles?: string[]
  /** replaces the document's `x-agent.namePrefix` (`''` strips it) */
  namePrefix?: string
  // … the other options unchanged
}

export function buildInstructions (doc: JsonSchema, profiles: string[], ops: ResolvedOperation[], locale: string): string {
  const root: AgentRoot = doc['x-agent'] ?? {}
  const selected = selectProfiles(profiles, expandProfiles(root.profiles))
  const sections: string[] = []
  for (const skill of root.skills ?? []) {
    if (skill.profiles && !skill.profiles.some(p => selected.has(p))) continue
    // … unchanged
  }
  // … tag sections unchanged
}
```

and in `load()`:

```ts
  const declared = Object.keys((doc['x-agent'] as AgentRoot | undefined)?.profiles ?? {})
  const profiles = options.profiles ?? (options.profile ? [options.profile] : [defaultProfile(doc)])
  if (!profiles.length) throw new Error('profiles must name at least one profile')
  for (const p of profiles) {
    if (declared.length && !declared.includes(p)) throw new Error(`unknown profile "${p}" (declared: ${declared.join(', ')})`)
  }
  // … replace every later use of `profile` with `profiles`:
  const ops = resolveOperations(doc, profiles, { namePrefix: options.namePrefix })
  // …
  const instructions = [buildInstructions(doc, profiles, ops, o.locale), ...editorSections].filter(Boolean).join('\n\n')
  return { profiles, instructions, tools }
```

`src/bin/server.ts` lines 56 and 60: `profile ${toolSet.profile}` → `profiles ${toolSet.profiles.join(',')}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run quality`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/spec.ts src/load.ts src/types.ts src/bin/server.ts test/spec.test.ts test/load.test.ts
git commit -m "feat: select operations by a set of profiles; name prefix override"
```

---

### Task 3: `CallContext` — identity per call

**Files:**
- Modify: `src/types.ts` (`CallContext`, `Tool.execute`)
- Create: `src/context.ts`
- Modify: `src/load.ts:82-90` (`execute`), `src/load.ts:158` (editor context)
- Modify: `src/editor/bridge.ts:26-55`, `src/editor/index.ts:22-48`
- Test: `test/context.test.ts`, `test/load.test.ts`, `test/editor-group.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // src/types.ts
  export interface CallContext { fetch?: typeof fetch; headers?: Record<string, string>; signal?: AbortSignal; identity?: string }
  export interface Tool { /* … */ execute (params: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult> }
  // src/context.ts
  export function callFetch (request: Request, ctx: CallContext | undefined, fallback: typeof fetch): Promise<Response>
  export const currentCall: AsyncLocalStorage<CallContext | undefined>
  export function contextualFetch (fallback: typeof fetch): typeof fetch
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/context.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { callFetch, contextualFetch, currentCall } from '../src/context.ts'

const recorder = () => {
  const seen: Request[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(input instanceof Request ? input : new Request(input, init))
    return new Response('ok')
  }) as typeof fetch
  return { seen, fetchFn }
}

describe('callFetch', () => {
  it('uses the fallback fetch and leaves the request alone without a context', async () => {
    const { seen, fetchFn } = recorder()
    await callFetch(new Request('https://api.test/x', { headers: { accept: 'application/json' } }), undefined, fetchFn)
    assert.equal(seen[0].headers.get('accept'), 'application/json')
    assert.equal(seen[0].headers.get('cookie'), null)
  })
  it('merges context headers, overriding a header the request already carries', async () => {
    const { seen, fetchFn } = recorder()
    await callFetch(new Request('https://api.test/x', { headers: { cookie: 'old=1' } }), { headers: { cookie: 'id_token=abc', 'x-apikey': 'k' } }, fetchFn)
    assert.equal(seen[0].headers.get('cookie'), 'id_token=abc')
    assert.equal(seen[0].headers.get('x-apikey'), 'k')
  })
  it('prefers the context fetch over the fallback', async () => {
    const fallback = recorder()
    const own = recorder()
    await callFetch(new Request('https://api.test/x'), { fetch: own.fetchFn }, fallback.fetchFn)
    assert.equal(own.seen.length, 1)
    assert.equal(fallback.seen.length, 0)
  })
  it('attaches the context signal', async () => {
    const { seen, fetchFn } = recorder()
    const controller = new AbortController()
    await callFetch(new Request('https://api.test/x'), { signal: controller.signal }, fetchFn)
    assert.equal(seen[0].signal, controller.signal)
  })
})

describe('contextualFetch', () => {
  it('reads the context of the call in progress', async () => {
    const { seen, fetchFn } = recorder()
    const f = contextualFetch(fetchFn)
    await currentCall.run({ headers: { cookie: 'a=1' } }, () => f('https://api.test/x'))
    await f('https://api.test/y')
    assert.equal(seen[0].headers.get('cookie'), 'a=1')
    assert.equal(seen[1].headers.get('cookie'), null)
  })
})
```

Add to `test/load.test.ts`:

```ts
  it('applies the call context to the upstream request', async () => {
    const { fetchFn, calls } = stub(() => json({ total: 0, results: [] }))
    const ts = await load(petstore, { fetch: fetchFn })
    await ts.tools[0].execute({}, { headers: { cookie: 'id_token=abc' } })
    assert.equal(calls[0].headers.get('cookie'), 'id_token=abc')
  })
```

Add to `test/editor-group.test.ts` (uses the file's `doc`, `fetchFn`, `calls`):

```ts
  it('partitions sessions by identity and sends each call with its own headers', async () => {
    const { tools } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'dataset_line_setFieldValue')!
    const get = tools.find(t => t.name === 'dataset_line_getData')!
    calls.length = 0
    await set.execute({ id: 'ds', lineId: 'l1', path: '/nom', value: 'Brest' }, { identity: 'alice', headers: { cookie: 'who=alice' } })
    const bob = await get.execute({ id: 'ds', lineId: 'l1' }, { identity: 'bob', headers: { cookie: 'who=bob' } })
    assert.match(bob.text, /Rennes/, "bob's session loads the record, not alice's edit")
    assert.doesNotMatch(bob.text, /Brest/)
    const cookies = calls.map(c => c.cookie)
    assert.ok(cookies.includes('who=alice') && cookies.includes('who=bob'), `each session fetched with its caller's headers: ${cookies}`)
    const alice = await get.execute({ id: 'ds', lineId: 'l1' }, { identity: 'alice' })
    assert.match(alice.text, /Brest/, "alice's session keeps her edit")
  })
```

and extend the file's recording `fetchFn` to keep the cookie: change the `calls` type to `{ method: string, url: string, body?: string, cookie?: string | null }[]` and push `cookie: input.headers.get('cookie')`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/context.test.ts test/load.test.ts test/editor-group.test.ts`
Expected: `context.test.ts` cannot import `src/context.ts`; the load case finds no cookie; the editor case sees one shared session.

- [ ] **Step 3: Implement**

`src/types.ts`:

```ts
/**
 * What a single call carries. The library never produces one: a server derives it from
 * the request it is serving (cookies, an API key, a caller key); on stdio there is none and
 * identity is the environment.
 */
export interface CallContext {
  /** wins over the load-time fetch for this call */
  fetch?: typeof fetch
  /** merged into the upstream request; overrides a header already present */
  headers?: Record<string, string>
  signal?: AbortSignal
  /** opaque caller key partitioning stateful tool groups (editor sessions) */
  identity?: string
}

export interface Tool {
  // … unchanged fields
  execute (params: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult>
}
```

Create `src/context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import type { CallContext } from './types.ts'

/** Send `request` under `ctx`: its headers merged in, its signal attached, its fetch preferred. */
export function callFetch (request: Request, ctx: CallContext | undefined, fallback: typeof fetch): Promise<Response> {
  for (const [name, value] of Object.entries(ctx?.headers ?? {})) request.headers.set(name, value)
  const req = ctx?.signal ? new Request(request, { signal: ctx.signal }) : request
  return (ctx?.fetch ?? fallback)(req)
}

/**
 * The context of the call in progress, for code that runs inside a tool call but is not
 * handed the context explicitly — a json-layout session's own HTTP calls. Set by the editor
 * bridge around every call; read by `contextualFetch`.
 */
export const currentCall = new AsyncLocalStorage<CallContext | undefined>()

/** A fetch that applies whatever context the call in progress carries. */
export function contextualFetch (fallback: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init)
    return callFetch(request, currentCall.getStore(), fallback)
  }) as typeof fetch
}
```

`src/load.ts` — in `makeTool`'s `execute`:

```ts
    async execute (rawParams, ctx): Promise<ToolResult> {
      // … validation unchanged
      let res: Response
      try {
        const req = buildRequest(op, bindings, params, o.baseUrl)
        debug('%s %s', req.method, req.url)
        res = await callFetch(req, ctx, o.fetch)
      } catch (err: any) {
        return { isError: true, text: `Request failed: ${err?.message ?? err}` }
      }
      // … unchanged
```

and where editor groups are built:

```ts
    const group = await buildEditorTools(op, { doc, baseUrl, fetch: contextualFetch(fetchFn), locale: o.locale })
```

with `import { callFetch, contextualFetch } from './context.ts'`.

`src/editor/bridge.ts` — the resolver takes the context and the call runs inside it:

```ts
import { currentCall } from '../context.ts'
import type { CallContext, JsonSchema, ResolvedParam, Tool, ToolResult } from '../types.ts'

export function bridgeTool (descriptor: FormTool, pathParams: ResolvedParam[], resolve: (pathValues: Record<string, unknown>, ctx: CallContext | undefined) => Promise<FormTool>): Tool {
  // … input schema unchanged
    async execute (params: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult> {
      // … pathValues / rest unchanged
      try {
        // The session's own requests (schema, load, save) happen inside this call and must
        // carry this call's headers — an NHI cookie rotates every two minutes, so nothing
        // captured when the session was opened may be reused.
        return await currentCall.run(ctx, async () => {
          const tool = await resolve(pathValues, ctx)
          return toToolResult(await tool.execute(rest))
        })
      } catch (err) {
        return { isError: true, text: `Error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
```

`src/editor/index.ts` — key sessions by identity:

```ts
  return descriptors.map(descriptor => bridgeTool(descriptor, pathParams, async (pathValues, callCtx) => {
    // One session per caller and record: two users editing the same record must not share
    // one. Without an identity the process is one caller (stdio) and sessions are global.
    const key = `${callCtx?.identity ?? ''}:${op.toolName}:${pathParams.map(p => String(pathValues[p.name])).join(':')}`
    // … unchanged
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run quality`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/context.ts src/load.ts src/editor/bridge.ts src/editor/index.ts test/context.test.ts test/load.test.ts test/editor-group.test.ts
git commit -m "feat: per-call context — identity travels with the call, not the tool set"
```

---

### Task 4: Skills in the tool set, and the SKILL.md file

**Files:**
- Modify: `src/types.ts` (`Skill`, `ToolSet.skills`)
- Create: `src/skills.ts`
- Modify: `src/load.ts` (`load` returns `skills`)
- Test: `test/skills.test.ts`, `test/load.test.ts`

**Interfaces:**
- Consumes: `selectProfiles`/`expandProfiles` (Task 1), `localize` (`src/localize.ts`).
- Produces:
  ```ts
  // src/types.ts
  export interface Skill { id: string; name: string; description: string; body: string; tools?: string[]; profiles?: string[] }
  export interface ToolSet { profiles: string[]; instructions: string; tools: Tool[]; skills: Skill[] }
  // src/skills.ts
  export function buildSkills (skills: AgentSkill[] | undefined, selected: Set<string>, locale: string): Skill[]
  export interface SkillFile { uri: string; frontmatter: { name: string; description: string }; text: string; digest: string; size: number }
  export function renderSkillFile (skill: Skill): SkillFile
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/skills.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildSkills, renderSkillFile } from '../src/skills.ts'

describe('buildSkills', () => {
  it('filters by the selected profiles and splits a first paragraph off as the description', () => {
    const skills = buildSkills([
      { name: 'workflow', description: { en: 'Start with list.\n\nThen filter.\nThen aggregate.', fr: 'Commencez.' }, tools: ['list', 'search'] },
      { name: 'editing', description: 'Only when asked.', profiles: ['edit'] }
    ], new Set(['explore']), 'en')
    assert.deepEqual(skills, [{
      id: 'workflow',
      name: 'workflow',
      description: 'Start with list.',
      body: 'Start with list.\n\nThen filter.\nThen aggregate.\n\nTools: list, search',
      tools: ['list', 'search'],
      profiles: undefined
    }])
  })
  it('caps the description at 1024 characters', () => {
    const [skill] = buildSkills([{ name: 'long', description: 'x'.repeat(2000) }], new Set(['explore']), 'en')
    assert.equal(skill.description.length, 1024)
  })
})

describe('renderSkillFile', () => {
  it('renders SKILL.md with quoted frontmatter, and a digest over its bytes', () => {
    const file = renderSkillFile({ id: 'data-fair/workflow', name: 'workflow', description: 'Say "hi": now', body: 'Body.' })
    assert.equal(file.uri, 'skill://data-fair/workflow/SKILL.md')
    assert.equal(file.text, '---\nname: workflow\ndescription: "Say \\"hi\\": now"\n---\n\nBody.\n')
    assert.deepEqual(file.frontmatter, { name: 'workflow', description: 'Say "hi": now' })
    assert.equal(file.size, Buffer.byteLength(file.text))
    assert.equal(file.digest, 'sha256:' + createHash('sha256').update(file.text).digest('hex'))
  })
})
```

Add to `test/load.test.ts`'s first test (`builds the tool set for the default profile…`):

```ts
    assert.deepEqual(ts.skills.map(s => [s.id, s.description]), [['workflow', 'Start with list_pets, then get_pet.']])
```

and to `localizes and switches profile`:

```ts
    assert.deepEqual(ts.skills.map(s => s.id), ['workflow', 'editing'])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/skills.test.ts test/load.test.ts`
Expected: import failure for `src/skills.ts`; `ts.skills` undefined.

- [ ] **Step 3: Implement**

`src/types.ts`:

```ts
/** A text-only skill, ready to be served as a `skill://` resource or rendered into instructions. */
export interface Skill {
  /** `<skill-name>` for a single document, `<service-id>/<skill-name>` once composed */
  id: string
  name: string
  /** the first paragraph, at most 1024 characters — the SKILL.md frontmatter description */
  description: string
  /** the whole localized text, plus a `Tools:` line when the annotation lists tools */
  body: string
  tools?: string[]
  profiles?: string[]
}

export interface ToolSet {
  profiles: string[]
  instructions: string
  tools: Tool[]
  skills: Skill[]
}
```

Create `src/skills.ts`:

```ts
import { createHash } from 'node:crypto'
import { localize } from './localize.ts'
import type { AgentSkill, Skill } from './types.ts'

const MAX_DESCRIPTION = 1024

export function buildSkills (skills: AgentSkill[] | undefined, selected: Set<string>, locale: string): Skill[] {
  const out: Skill[] = []
  for (const skill of skills ?? []) {
    if (skill.profiles && !skill.profiles.some(p => selected.has(p))) continue
    const text = (localize(skill.description, locale) ?? '').trim()
    const description = text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION)
    const body = skill.tools?.length ? `${text}\n\nTools: ${skill.tools.join(', ')}` : text
    out.push({ id: skill.name, name: skill.name, description, body, tools: skill.tools, profiles: skill.profiles })
  }
  return out
}

export interface SkillFile {
  uri: string
  frontmatter: { name: string, description: string }
  text: string
  /** `sha256:` + 64 lowercase hex over `text`'s UTF-8 bytes */
  digest: string
  size: number
}

/** The SKILL.md a host reads through `resources/read`, with the entry fields `skills/list` publishes. */
export function renderSkillFile (skill: Skill): SkillFile {
  const frontmatter = { name: skill.name, description: skill.description }
  // JSON.stringify yields a valid double-quoted YAML scalar; the name needs no quoting by its pattern.
  const text = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`
  const bytes = Buffer.from(text, 'utf8')
  return {
    uri: `skill://${skill.id}/SKILL.md`,
    frontmatter,
    text,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.length
  }
}
```

`src/load.ts` — in `load()`, before the return:

```ts
  const selected = selectProfiles(profiles, expandProfiles(root.profiles))
  const skills = buildSkills(root.skills, selected, o.locale)
  return { profiles, instructions, tools, skills }
```

where `root` is `(doc['x-agent'] as AgentRoot | undefined) ?? {}` (hoist it next to `declared`), with `import { buildSkills } from './skills.ts'`. Tag skills (`tags[].x-agent.skill`) have no name and stay in instructions only.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run quality`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/skills.ts src/load.ts test/skills.test.ts test/load.test.ts
git commit -m "feat: skills as first-class tool set members, rendered as SKILL.md"
```

---

### Task 5: `toolSetSnapshot`

**Files:**
- Create: `src/snapshot.ts`
- Modify: `src/index.ts`
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ToolSetSnapshot { profiles: string[]; tools: { name: string; description: string; inputSchema: JsonSchema; annotations: ToolAnnotations }[]; skills: { id: string; name: string; description: string }[] }
  export function toolSetSnapshot (toolSet: ToolSet): ToolSetSnapshot
  ```

- [ ] **Step 1: Write the failing test**

Create `test/snapshot.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from '../src/load.ts'
import { toolSetSnapshot } from '../src/snapshot.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))

describe('toolSetSnapshot', () => {
  it('is a stable, JSON-serializable view of the agent-facing surface', async () => {
    const a = toolSetSnapshot(await load(petstore))
    const b = toolSetSnapshot(await load(petstore))
    assert.deepEqual(a, b)
    assert.deepEqual(Object.keys(a), ['profiles', 'tools', 'skills'])
    assert.deepEqual(Object.keys(a.tools[0]), ['name', 'description', 'inputSchema', 'annotations'])
    assert.deepEqual(a.skills, [{ id: 'workflow', name: 'workflow', description: 'Start with list_pets, then get_pet.' }])
    assert.equal(typeof JSON.stringify(a), 'string')
    assert.equal((a.tools[0] as any).execute, undefined)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/snapshot.test.ts`
Expected: cannot import `src/snapshot.ts`.

- [ ] **Step 3: Implement**

Create `src/snapshot.ts`:

```ts
import type { JsonSchema, ToolAnnotations, ToolSet } from './types.ts'

export interface ToolSetSnapshot {
  profiles: string[]
  tools: { name: string, description: string, inputSchema: JsonSchema, annotations: ToolAnnotations }[]
  skills: { id: string, name: string, description: string }[]
}

/**
 * The agent-facing surface of a tool set as plain data, for a committed golden: a service's
 * CI diffs it so an unintended change to a tool's name, description or schema is a
 * reviewable diff in the pull request that caused it.
 */
export function toolSetSnapshot (toolSet: ToolSet): ToolSetSnapshot {
  return {
    profiles: [...toolSet.profiles],
    tools: toolSet.tools.map(t => ({ name: t.name, description: t.description, inputSchema: structuredClone(t.inputSchema), annotations: { ...t.annotations } })),
    skills: toolSet.skills.map(s => ({ id: s.id, name: s.name, description: s.description }))
  }
}
```

`src/index.ts` — add `export { toolSetSnapshot, type ToolSetSnapshot } from './snapshot.ts'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run quality`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot.ts src/index.ts test/snapshot.test.ts
git commit -m "feat: toolSetSnapshot for per-service goldens"
```

---

### Task 6: Index contract and composer

**Files:**
- Create: `src/index-contract.ts`, `src/compose.ts`, `test/fixtures/vetstore.json`
- Modify: `src/index.ts`
- Test: `test/index-contract.test.ts`, `test/compose.test.ts`

**Interfaces:**
- Consumes: `load`, `loadSpec`, `defaultProfile` (`src/spec.ts`), `expandProfiles`/`selectProfiles`, `buildSkills`, `toolSetSnapshot`, `localize`.
- Produces:
  ```ts
  // src/index-contract.ts
  export interface IndexService { id: string; openapi: string }
  export interface Index { version: 1; services: IndexService[]; profiles?: Record<string, { title?: Localized; description?: Localized; includes?: string[] }>; skills?: AgentSkill[] }
  export function validateIndex (value: unknown): Index          // throws with a path on failure
  // src/compose.ts
  export interface ServiceStatus { id: string; openapi: string; status: 'ok' | 'skipped' | 'error'; tools: number; reason?: string }
  export interface ProfileInfo { name: string; title?: string; description?: string; includes?: string[]; services: string[] }
  export interface Composition { readonly toolSet: ToolSet; readonly services: ServiceStatus[]; onChange (cb: (toolSet: ToolSet) => void): () => void }
  export interface Composer { readonly index: Index; readonly services: ServiceStatus[]; profiles (): ProfileInfo[]; compose (profiles?: string[]): Composition; refresh (): Promise<boolean>; onChange (cb: () => void): () => void }
  export type ComposerOptions = Omit<LoadOptions, 'profile' | 'profiles'>
  export function createComposer (index: string | Index, options?: ComposerOptions): Promise<Composer>
  export function compose (index: string | Index, options?: ComposerOptions & { profiles?: string[] }): Promise<Composition>
  ```

- [ ] **Step 1: Create the second service fixture**

Create `test/fixtures/vetstore.json`:

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Vets", "version": "1" },
  "servers": [{ "url": "https://vets.example/api" }],
  "x-agent": {
    "namePrefix": "vets_",
    "profiles": {
      "explore": { "title": "Explore" },
      "edit_appointments": { "title": "Edit appointments" },
      "edit": { "title": "Edit", "includes": ["edit_appointments"] }
    },
    "skills": [
      { "name": "booking", "description": "Book with create_appointment after list_vets.", "profiles": ["edit"] }
    ]
  },
  "paths": {
    "/vets": {
      "get": {
        "operationId": "listVets",
        "x-agent": { "profiles": ["explore"], "name": "list_vets", "description": "List vets." },
        "responses": { "200": { "description": "ok", "content": { "application/json": { "schema": { "type": "object", "properties": { "results": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "name": { "type": "string" } } } } } } } } } }
      }
    },
    "/appointments": {
      "post": {
        "operationId": "createAppointment",
        "x-agent": { "profiles": ["edit_appointments"], "name": "create_appointment", "description": "Book an appointment." },
        "requestBody": { "required": true, "content": { "application/json": { "schema": { "type": "object", "properties": { "vetId": { "type": "string" }, "at": { "type": "string" } } } } } },
        "responses": { "201": { "description": "created", "content": { "application/json": { "schema": { "type": "object" } } } } }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/index-contract.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateIndex } from '../src/index-contract.ts'

describe('validateIndex', () => {
  it('accepts a minimal index and one with profiles and skills', () => {
    assert.doesNotThrow(() => validateIndex({ version: 1, services: [{ id: 'data-fair', openapi: 'https://h/api-docs.json' }] }))
    assert.doesNotThrow(() => validateIndex({
      version: 1,
      services: [{ id: 'data-fair', openapi: 'https://h/api-docs.json' }],
      profiles: { full: { title: 'Full', includes: ['explore', 'edit'] } },
      skills: [{ name: 'publishing-workflow', description: 'd', profiles: ['edit'], tools: ['a'] }]
    }))
  })
  it('refuses an unknown version, a bad id, a duplicate id and an unknown key', () => {
    assert.throws(() => validateIndex({ version: 2, services: [] }), /index invalid: \/version/)
    assert.throws(() => validateIndex({ version: 1, services: [{ id: 'Data Fair', openapi: 'https://h' }] }), /\/services\/0\/id/)
    assert.throws(() => validateIndex({ version: 1, services: [{ id: 'a', openapi: 'https://h' }, { id: 'a', openapi: 'https://h2' }] }), /duplicate service id "a"/)
    assert.throws(() => validateIndex({ version: 1, services: [], indexes: [] }), /indexes/)
  })
})
```

Create `test/compose.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createComposer, compose } from '../src/compose.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
const vetstore = JSON.parse(await readFile(new URL('./fixtures/vetstore.json', import.meta.url), 'utf8'))

/**
 * An HTTP stub keyed by URL with ETags: a request whose If-None-Match equals the current
 * ETag gets a 304. `set` replaces a document and bumps its ETag.
 */
function stack () {
  const docs = new Map<string, { body: unknown, etag: string }>()
  const hits: Record<string, number> = {}
  const set = (url: string, body: unknown) => docs.set(url, { body, etag: `"${(docs.get(url)?.etag.length ?? 0) + 1}-${Date.now()}"` })
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init)
    hits[req.url] = (hits[req.url] ?? 0) + 1
    const doc = docs.get(req.url)
    if (!doc) return new Response('not found', { status: 404 })
    if (req.headers.get('if-none-match') === doc.etag) return new Response(null, { status: 304, headers: { etag: doc.etag } })
    return new Response(JSON.stringify(doc.body), { headers: { 'content-type': 'application/json', etag: doc.etag } })
  }) as typeof fetch
  return { set, fetchFn, hits }
}

const INDEX = 'https://idx.test/index.json'
const PETS = 'https://pets.test/openapi.json'
const VETS = 'https://vets.test/openapi.json'

function base () {
  const s = stack()
  s.set(INDEX, {
    version: 1,
    services: [{ id: 'pets', openapi: PETS }, { id: 'vets', openapi: VETS }],
    profiles: { explore: { title: 'Explore everything' }, full: { title: 'Full', includes: ['explore', 'edit'] } },
    skills: [{ name: 'cross-booking', description: 'Find a pet, then book a vet.', profiles: ['edit'] }]
  })
  s.set(PETS, petstore)
  s.set(VETS, vetstore)
  return s
}

describe('createComposer', () => {
  it('merges the services in index order for one profile, and lists the union of profiles', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = composer.compose(['explore'])
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet', 'vets_list_vets'])
    assert.deepEqual(c.toolSet.profiles, ['explore'])
    assert.deepEqual(c.services.map(x => [x.id, x.status, x.tools]), [['pets', 'ok', 2], ['vets', 'ok', 1]])
    assert.match(c.toolSet.instructions, /^# Pets\n\n## workflow/)
    assert.match(c.toolSet.instructions, /# Vets/)
    assert.doesNotMatch(c.toolSet.instructions, /cross-booking/, 'an edit-only index skill is not in the explore set')
    assert.deepEqual(c.toolSet.skills.map(x => x.id), ['pets/workflow'])
    const profiles = composer.profiles()
    assert.deepEqual(profiles.map(p => [p.name, p.title, p.services]), [
      ['explore', 'Explore everything', ['pets', 'vets']],
      ['full', 'Full', []],
      ['edit', 'Edit', ['pets', 'vets']],
      ['edit_appointments', 'Edit appointments', ['vets']]
    ])
    assert.deepEqual(profiles.find(p => p.name === 'full')!.includes, ['explore', 'edit'])
  })

  it('selects a set once per operation, expanding document and index includes', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const full = composer.compose(['full'])
    assert.deepEqual(full.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_create_pet', 'pets_get_pet', 'vets_list_vets', 'vets_create_appointment'])
    assert.deepEqual(full.toolSet.skills.map(x => x.id), ['cross-booking', 'pets/workflow', 'pets/editing', 'vets/booking'])
    assert.match(full.toolSet.instructions, /^## cross-booking\n\nFind a pet, then book a vet\.\n\n# Pets/)
    const same = composer.compose(['full'])
    assert.equal(same, full, 'memoized per distinct set')
    assert.equal(composer.compose(['edit', 'explore']), composer.compose(['explore', 'edit']))
  })

  it('skips a service declaring none of the requested profiles, and defaults to the index default', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = composer.compose(['edit_appointments'])
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['vets_create_appointment'])
    assert.deepEqual(c.services.map(x => [x.id, x.status, x.reason]), [['pets', 'skipped', 'declares none of [edit_appointments]'], ['vets', 'ok', undefined]])
    assert.deepEqual(composer.compose().toolSet.profiles, ['explore'])
    assert.deepEqual(composer.compose([]).toolSet.profiles, ['explore'])
  })

  it('serves a partial set when a service fails, and throws only on a bad index', async () => {
    const s = base()
    s.set(VETS, { openapi: '3.1.0', info: { title: 'Broken', version: '1' }, 'x-agent': { skills: [{ name: 'Bad Name', description: 'd' }] }, paths: {} })
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = composer.compose(['explore'])
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.equal(c.services[1].status, 'error')
    assert.match(c.services[1].reason!, /x-agent invalid/)
    await assert.rejects(createComposer('https://idx.test/missing.json', { fetch: s.fetchFn }), /HTTP 404/)
    s.set(INDEX, { version: 2, services: [] })
    await assert.rejects(createComposer(INDEX, { fetch: s.fetchFn }), /index invalid: \/version/)
  })

  it('excludes the later service on a tool name collision, naming both', async () => {
    const s = base()
    s.set(VETS, { ...vetstore, 'x-agent': { ...vetstore['x-agent'], namePrefix: 'pets_' }, paths: { '/vets': { get: { ...vetstore.paths['/vets'].get, 'x-agent': { profiles: ['explore'], name: 'list_pets' } } } } })
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = composer.compose(['explore'])
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.deepEqual(c.services[1], { id: 'vets', openapi: VETS, status: 'error', tools: 0, reason: 'tool name collision with pets: pets_list_pets' })
  })

  it('refreshes with conditional requests, rebuilding only what changed, and notifies once', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = composer.compose(['explore'])
    let notified = 0
    c.onChange(() => notified++)
    let composerNotified = 0
    composer.onChange(() => composerNotified++)

    assert.equal(await composer.refresh(), false)
    assert.deepEqual([s.hits[INDEX], s.hits[PETS], s.hits[VETS]], [2, 2, 2], 'every document revalidated, none rebuilt')
    assert.equal(notified, 0)

    s.set(VETS, { ...vetstore, paths: { ...vetstore.paths, '/vets': { get: { ...vetstore.paths['/vets'].get, 'x-agent': { profiles: ['explore'], name: 'list_all_vets', description: 'List vets.' } } } } })
    assert.equal(await composer.refresh(), true)
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet', 'vets_list_all_vets'])
    assert.equal(notified, 1)
    assert.equal(composerNotified, 1)

    // a new ETag over unchanged bytes is not a change of the set
    s.set(PETS, petstore)
    assert.equal(await composer.refresh(), false)
    assert.equal(notified, 1)

    // the index itself changes: a service is removed
    s.set(INDEX, { version: 1, services: [{ id: 'pets', openapi: PETS }] })
    assert.equal(await composer.refresh(), true)
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.deepEqual(composer.services.map(x => x.id), ['pets'])
  })

  it('fetches each document once however many sets are composed, and executes through the call context', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    composer.compose(['explore']); composer.compose(['edit']); composer.compose(['full'])
    assert.deepEqual([s.hits[PETS], s.hits[VETS]], [1, 1])
    const seen: Request[] = []
    const upstream = (async (input: RequestInfo | URL) => { seen.push(input as Request); return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } }) }) as typeof fetch
    const tool = composer.compose(['explore']).toolSet.tools.find(t => t.name === 'vets_list_vets')!
    await tool.execute({}, { fetch: upstream, headers: { cookie: 'c=1' } })
    assert.equal(seen[0].url, 'https://vets.example/api/vets')
    assert.equal(seen[0].headers.get('cookie'), 'c=1')
  })

  it('compose() is the one-shot convenience', async () => {
    const s = base()
    const c = await compose(INDEX, { fetch: s.fetchFn, profiles: ['edit'] })
    assert.deepEqual(c.toolSet.tools.map(t => t.name), ['pets_create_pet', 'vets_create_appointment'])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/index-contract.test.ts test/compose.test.ts`
Expected: both fail to import their module.

- [ ] **Step 4: Implement the index contract**

Create `src/index-contract.ts`:

```ts
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AgentSkill, Localized } from './types.ts'

export interface IndexService { id: string, openapi: string }
export interface IndexProfile { title?: Localized, description?: Localized, includes?: string[] }
export interface Index {
  version: 1
  services: IndexService[]
  profiles?: Record<string, IndexProfile>
  skills?: AgentSkill[]
}

const localized = { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: { type: 'string' }, minProperties: 1 }] }

export const indexSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'services'],
  properties: {
    version: { const: 1 },
    services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'openapi'],
        properties: { id: { type: 'string', pattern: '^[a-z0-9-]+$' }, openapi: { type: 'string', format: 'uri' } }
      }
    },
    profiles: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: { title: localized, description: localized, includes: { type: 'array', items: { type: 'string' }, minItems: 1 } }
      }
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 },
          description: localized,
          profiles: { type: 'array', items: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validate = ajv.compile(indexSchema)

/** The one document this library dictates the shape of. Throws naming the first offending path. */
export function validateIndex (value: unknown): Index {
  if (!validate(value)) {
    const msg = validate.errors!.map(e => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`).join('; ')
    throw new Error(`index invalid: ${msg}`)
  }
  const index = value as Index
  const seen = new Set<string>()
  for (const s of index.services) {
    if (seen.has(s.id)) throw new Error(`index invalid: duplicate service id "${s.id}"`)
    seen.add(s.id)
  }
  return index
}
```

Note: `format: 'uri'` needs `ajv-formats` — the repository already depends on it; add `addFormats(ajv)` exactly as `src/load.ts` does (same cast), or drop `format` and keep `type: 'string'`. Use the same cast as `load.ts` (`addFormatsModule as unknown as FormatsPlugin`).

- [ ] **Step 5: Implement the composer**

Create `src/compose.ts`:

```ts
import Debug from 'debug'
import { load, type LoadOptions } from './load.ts'
import { loadSpec, defaultProfile } from './spec.ts'
import { expandProfiles, selectProfiles } from './profiles.ts'
import { buildSkills } from './skills.ts'
import { toolSetSnapshot } from './snapshot.ts'
import { localize } from './localize.ts'
import { validateIndex, type Index, type IndexService } from './index-contract.ts'
import type { AgentRoot, JsonSchema, Skill, Tool, ToolSet } from './types.ts'

const debug = Debug('openapi-mcp:compose')

export interface ServiceStatus {
  id: string
  openapi: string
  status: 'ok' | 'skipped' | 'error'
  tools: number
  reason?: string
}

export interface ProfileInfo {
  name: string
  title?: string
  description?: string
  includes?: string[]
  /** the services declaring this profile; empty for an index-only profile */
  services: string[]
}

export interface Composition {
  /** the current merged set; replaced, never mutated, when a refresh changes it */
  readonly toolSet: ToolSet
  readonly services: ServiceStatus[]
  /** called after a refresh that changed this composition's set; returns the unsubscribe */
  onChange (cb: (toolSet: ToolSet) => void): () => void
}

export interface Composer {
  readonly index: Index
  /** document-level statuses: `ok` or `error`, never `skipped` (that is per profile set) */
  readonly services: ServiceStatus[]
  /** every declared profile across the documents, expanded, index wording winning */
  profiles (): ProfileInfo[]
  /** memoized per distinct set; an empty or absent set means the default profile */
  compose (profiles?: string[]): Composition
  /** conditional GETs for the index and every document; rebuilds what changed; true if any live set changed */
  refresh (): Promise<boolean>
  /** called after a refresh that changed at least one live composition */
  onChange (cb: () => void): () => void
}

export type ComposerOptions = Omit<LoadOptions, 'profile' | 'profiles'>

/** One HTTP resource with its validators, fetched conditionally. */
interface Cached<T> {
  url: string
  etag?: string
  lastModified?: string
  value?: T
  error?: string
}

interface CachedDoc extends Cached<JsonSchema> { id: string }

interface LiveComposition extends Composition { key: string, rebuild (): Promise<boolean> }

async function fetchConditional<T> (entry: Cached<T>, fetchFn: typeof fetch, parse: (json: unknown) => T): Promise<boolean> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (entry.etag) headers['if-none-match'] = entry.etag
  if (entry.lastModified) headers['if-modified-since'] = entry.lastModified
  let res: Response
  try {
    res = await fetchFn(entry.url, { headers })
  } catch (err: any) {
    entry.error = `fetch failed: ${err?.message ?? err}`
    return entry.value === undefined ? false : (entry.value = undefined, true)
  }
  if (res.status === 304) return false
  if (!res.ok) {
    entry.error = `HTTP ${res.status}`
    const had = entry.value !== undefined
    entry.value = undefined
    return had
  }
  entry.etag = res.headers.get('etag') ?? undefined
  entry.lastModified = res.headers.get('last-modified') ?? undefined
  try {
    entry.value = parse(await res.json())
    entry.error = undefined
  } catch (err: any) {
    entry.error = err?.message ?? String(err)
    entry.value = undefined
  }
  return true
}

function setKey (profiles: string[]): string {
  return [...new Set(profiles)].sort().join(',')
}

export async function createComposer (index: string | Index, options: ComposerOptions = {}): Promise<Composer> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const locale = options.locale ?? 'en'

  const indexEntry: Cached<Index> = { url: typeof index === 'string' ? index : '' }
  if (typeof index === 'string') {
    await fetchConditional(indexEntry, fetchFn, validateIndex)
    if (!indexEntry.value) throw new Error(`failed to load index ${index}: ${indexEntry.error}`)
  } else {
    indexEntry.value = validateIndex(index)
  }
  let current: Index = indexEntry.value

  const docs = new Map<string, CachedDoc>()
  const listeners = new Set<() => void>()
  const compositions = new Map<string, LiveComposition>()

  /** Validated and $ref-inlined once per fetch; `load()` on the result is cheap. */
  const parseDoc = (json: unknown) => json as JsonSchema
  const loadDoc = async (entry: CachedDoc) => {
    const changed = await fetchConditional(entry, fetchFn, parseDoc)
    if (changed && entry.value) {
      try {
        entry.value = await loadSpec(entry.value, fetchFn)
      } catch (err: any) {
        entry.error = err?.message ?? String(err)
        entry.value = undefined
      }
    }
    return changed
  }
  const syncServices = async (): Promise<boolean> => {
    let changed = false
    const ids = new Set(current.services.map(s => s.id))
    for (const id of [...docs.keys()]) if (!ids.has(id)) { docs.delete(id); changed = true }
    await Promise.all(current.services.map(async (s: IndexService) => {
      let entry = docs.get(s.id)
      if (!entry || entry.url !== s.openapi) {
        entry = { id: s.id, url: s.openapi }
        docs.set(s.id, entry)
      }
      if (await loadDoc(entry)) changed = true
    }))
    return changed
  }
  await syncServices()

  const orderedDocs = () => current.services.map(s => docs.get(s.id)!).filter(Boolean)
  const rootOf = (doc: JsonSchema): AgentRoot => doc['x-agent'] ?? {}

  const defaultProfiles = (): string[] => {
    const first = Object.keys(current.profiles ?? {})[0]
    if (first) return [first]
    const doc = orderedDocs().find(d => d.value)?.value
    return [doc ? defaultProfile(doc) : 'default']
  }

  const profiles = (): ProfileInfo[] => {
    const out = new Map<string, ProfileInfo>()
    for (const [name, p] of Object.entries(current.profiles ?? {})) {
      out.set(name, { name, title: localize(p.title, locale), description: localize(p.description, locale), includes: p.includes, services: [] })
    }
    for (const d of orderedDocs()) {
      if (!d.value) continue
      for (const [name, p] of Object.entries(rootOf(d.value).profiles ?? {})) {
        const info = out.get(name) ?? { name, services: [] }
        info.title ??= localize(p.title, locale)
        info.description ??= localize(p.description, locale)
        if (!info.includes && p.includes) info.includes = p.includes
        info.services.push(d.id)
        out.set(name, info)
      }
    }
    return [...out.values()]
  }

  const build = async (requested: string[]): Promise<{ toolSet: ToolSet, services: ServiceStatus[] }> => {
    const tools: Tool[] = []
    const names = new Map<string, string>()
    const sections: string[] = []
    const skills: Skill[] = []
    const statuses: ServiceStatus[] = []
    const indexSelected = selectProfiles(requested, expandProfiles(undefined, current.profiles))
    skills.push(...buildSkills(current.skills, indexSelected, locale))
    for (const s of skills) sections.push(`## ${s.name}\n\n${s.body}`)

    for (const d of orderedDocs()) {
      const status: ServiceStatus = { id: d.id, openapi: d.url, status: 'ok', tools: 0 }
      statuses.push(status)
      if (!d.value) { status.status = 'error'; status.reason = d.error ?? 'not loaded'; continue }
      const root = rootOf(d.value)
      const declared = Object.keys(root.profiles ?? {})
      // Which of this document's profiles the request reaches, through the index's includes
      // and the document's own: `full` in the index reaching `edit` here reaching `edit_datasets`.
      const selected = selectProfiles([...indexSelected], expandProfiles(root.profiles, current.profiles))
      const subset = declared.filter(p => selected.has(p))
      if (declared.length && !subset.length) { status.status = 'skipped'; status.reason = `declares none of [${requested.join(', ')}]`; continue }
```

`build` is `async`: `load()` is asynchronous (editor groups import their peer lazily), so a composition cannot be built synchronously and `compose()` returns a `Promise<Composition>`, memoized per set on the promise. The interface is therefore:

```ts
export interface Composer {
  readonly index: Index
  readonly services: ServiceStatus[]
  profiles (): ProfileInfo[]
  compose (profiles?: string[]): Promise<Composition>   // memoized per distinct set
  refresh (): Promise<boolean>
  onChange (cb: () => void): () => void
}
```

and the per-document part of `build` (declared `async`) is:

```ts
      let ts: ToolSet
      try {
        ts = await load(d.value, { ...options, profiles: subset.length ? subset : requested })
      } catch (err: any) {
        status.status = 'error'; status.reason = err?.message ?? String(err); continue
      }
      const collision = ts.tools.find(t => names.has(t.name))
      if (collision) { status.status = 'error'; status.reason = `tool name collision with ${names.get(collision.name)}: ${collision.name}`; continue }
      for (const t of ts.tools) names.set(t.name, d.id)
      tools.push(...ts.tools)
      status.tools = ts.tools.length
      if (ts.instructions) sections.push(`# ${d.value.info?.title ?? d.id}\n\n${ts.instructions}`)
      skills.push(...ts.skills.map(s => ({ ...s, id: `${d.id}/${s.id}` })))
```

`LiveComposition` declares `rebuild (): Promise<boolean>`; the composition is one object literal:

```ts
interface LiveComposition extends Composition { key: string, rebuild (): Promise<boolean> }

  const makeComposition = async (requested: string[]): Promise<LiveComposition> => {
    const changeListeners = new Set<(toolSet: ToolSet) => void>()
    let built = await build(requested)
    let snapshot = JSON.stringify(toolSetSnapshot(built.toolSet))
    return {
      key: setKey(requested),
      get toolSet () { return built.toolSet },
      get services () { return built.services },
      onChange (cb) { changeListeners.add(cb); return () => changeListeners.delete(cb) },
      async rebuild () {
        const next = await build(requested)
        const nextSnapshot = JSON.stringify(toolSetSnapshot(next.toolSet))
        built = next
        if (nextSnapshot === snapshot) return false
        snapshot = nextSnapshot
        for (const cb of changeListeners) cb(built.toolSet)
        return true
      }
    }
  }

  const pending = new Map<string, Promise<LiveComposition>>()
  const compose = (requested?: string[]): Promise<Composition> => {
    const profilesRequested = requested?.length ? requested : defaultProfiles()
    const key = setKey(profilesRequested)
    let p = pending.get(key)
    if (!p) {
      p = makeComposition(profilesRequested).then(c => { compositions.set(key, c); return c })
      pending.set(key, p)
    }
    return p
  }

  const refresh = async (): Promise<boolean> => {
    let changed = false
    if (indexEntry.url) {
      if (await fetchConditional(indexEntry, fetchFn, validateIndex)) {
        if (indexEntry.value) { current = indexEntry.value; changed = true } else debug('index refresh failed: %s', indexEntry.error)
      }
    }
    if (await syncServices()) changed = true
    if (!changed) return false
    let any = false
    for (const c of compositions.values()) if (await c.rebuild()) any = true
    if (any) for (const cb of listeners) cb()
    return any
  }

  return {
    get index () { return current },
    get services () {
      return orderedDocs().map(d => ({ id: d.id, openapi: d.url, status: d.value ? 'ok' as const : 'error' as const, tools: 0, reason: d.error }))
    },
    profiles,
    compose,
    refresh,
    onChange (cb) { listeners.add(cb); return () => listeners.delete(cb) }
  }
}

export async function compose (index: string | Index, options: ComposerOptions & { profiles?: string[] } = {}): Promise<Composition> {
  const { profiles, ...rest } = options
  const composer = await createComposer(index, rest)
  return composer.compose(profiles)
}
```

`compose()` returns a promise, so every `composer.compose(...)` in the Step 2 tests is awaited (`const c = await composer.compose(['explore'])`, `assert.equal(await composer.compose(['full']), full)`, …); the memoization assertion compares the resolved compositions.

`src/index.ts` — add:

```ts
export { createComposer, compose, type Composer, type Composition, type ComposerOptions, type ServiceStatus, type ProfileInfo } from './compose.ts'
export { validateIndex, indexSchema, type Index, type IndexService, type IndexProfile } from './index-contract.ts'
export { expandProfiles, selectProfiles, matchesProfiles } from './profiles.ts'
export { buildSkills, renderSkillFile, type SkillFile } from './skills.ts'
export { callFetch, contextualFetch, currentCall } from './context.ts'
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run quality`
Expected: green. If `fetchConditional`'s comma-expression line trips the linter, rewrite it as an explicit `if`.

- [ ] **Step 7: Commit**

```bash
git add src/index-contract.ts src/compose.ts src/index.ts test/fixtures/vetstore.json test/index-contract.test.ts test/compose.test.ts
git commit -m "feat: compose an index of service documents into profile-set tool sets"
```

---

### Task 7: MCP adapter on SDK v2 with the skills extension

**Files:**
- Modify: `package.json` (dependencies)
- Rewrite: `src/adapters/mcp.ts`
- Modify: `src/bin/server.ts` (compile-only migration; features come in Task 8)
- Modify: `evals/arms.ts:13-14` (imports)
- Rewrite: `test/adapters-mcp.test.ts`
- Modify: `test/bin.test.ts:6-7` (imports)

**Interfaces:**
- Consumes: `ToolSet`, `Composition`, `Composer`, `renderSkillFile`, `CallContext`.
- Produces:
  ```ts
  export type ToolSource = ToolSet | Composition | Composer
  export interface McpAdapterOptions {
    context?: (request: Request | undefined) => CallContext | undefined
    profiles?: string[]        // used when the request carries no ?profiles=
    refreshMs?: number         // default 300_000; advertised as ttlMs
  }
  export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
  export function requestProfiles (request: Request | undefined): string[] | undefined
  export function resolveToolSet (source: ToolSource, profiles?: string[]): Promise<ToolSet>
  export function toMcpServer (toolSet: ToolSet, server: Server, options?: { ctx?: CallContext, refreshMs?: number }): void
  export function serverOptions (toolSet: ToolSet, refreshMs: number): ServerOptions
  export function createMcpServer (source: ToolSource, info: { name: string, version: string }, options?: McpAdapterOptions & { request?: Request }): Promise<Server>
  export function mcpServerFactory (source: ToolSource, info, options?: McpAdapterOptions): McpServerFactory
  export function createMcpHttpHandler (source: ToolSource, info, options?: McpAdapterOptions & CreateMcpHandlerOptions): McpHttpHandler
  ```

- [ ] **Step 1: Swap the SDK packages**

```bash
npm uninstall @modelcontextprotocol/sdk
npm install @modelcontextprotocol/server@^2.0.0 @modelcontextprotocol/node@^2.0.0
npm install -D @modelcontextprotocol/client@^2.0.0 zod@^4.2.0
```

Then `evals/arms.ts` lines 13–14 and `test/bin.test.ts` lines 6–7:

```ts
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
```

- [ ] **Step 2: Write the failing tests**

Rewrite `test/adapters-mcp.test.ts`:

```ts
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server as HttpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { z } from 'zod'
import { load } from '../src/load.ts'
import { createComposer } from '../src/compose.ts'
import { createMcpServer, createMcpHttpHandler } from '../src/adapters/mcp.ts'

const petstore = JSON.parse(await readFile(new URL('./fixtures/petstore.json', import.meta.url), 'utf8'))
const upstream: Request[] = []
const fetchFn = (async (input: RequestInfo | URL) => {
  const req = input as Request
  upstream.push(req)
  if (req.url.includes('/pets/')) return new Response('# Rex', { headers: { 'content-type': 'text/markdown' } })
  return new Response(JSON.stringify({ total: 1, results: [{ id: 'p1', name: 'Rex' }] }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const INFO = { name: 'test', version: '0.0.0' }
const SkillsList = z.object({ skills: z.array(z.any()), ttlMs: z.number().optional(), cacheScope: z.string().optional() }).passthrough()

async function inMemory () {
  const toolSet = await load(petstore, { fetch: fetchFn })
  const server = await createMcpServer(toolSet, INFO)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'client', version: '0.0.0' })
  await client.connect(clientTransport)
  return { client, toolSet }
}

describe('mcp adapter over a tool set (in-memory, 2025 era)', () => {
  it('lists tools with schemas, annotations, examples and instructions', async () => {
    const { client, toolSet } = await inMemory()
    assert.equal(client.getInstructions(), toolSet.instructions)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.equal(tools[0].inputSchema.type, 'object')
    assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false })
    assert.deepEqual(tools[0]._meta, { 'anthropic/inputExamples': [{ query: 'rex', size: 5 }] })
    assert.deepEqual(client.getServerCapabilities()?.extensions, { 'io.modelcontextprotocol/skills': {} })
  })
  it('calls tools, reports validation errors and unknown tools as isError', async () => {
    const { client } = await inMemory()
    const ok: any = await client.callTool({ name: 'pets_list_pets', arguments: { query: 'rex' } })
    assert.match(ok.content[0].text, /\| p1 \| Rex \|/)
    const md: any = await client.callTool({ name: 'pets_get_pet', arguments: { id: 'p1' } })
    assert.equal(md.content[0].text, '# Rex')
    const bad: any = await client.callTool({ name: 'pets_list_pets', arguments: { size: 999 } })
    assert.equal(bad.isError, true)
    const nope: any = await client.callTool({ name: 'nope', arguments: {} })
    assert.equal(nope.isError, true)
  })
  it('serves skills as resources and through skills/list + skills/get, digest matching the bytes', async () => {
    const { client } = await inMemory()
    const { resources } = await client.listResources()
    assert.deepEqual(resources.map(r => [r.uri, r.mimeType]), [['skill://workflow/SKILL.md', 'text/markdown']])
    const listed = await client.request({ method: 'skills/list', params: {} }, SkillsList)
    const entry = listed.skills[0]
    assert.deepEqual(entry.frontmatter, { name: 'workflow', description: 'Start with list_pets, then get_pet.' })
    assert.equal(listed.ttlMs, 300000)
    const read = await client.readResource({ uri: entry.uri })
    const text = (read.contents[0] as any).text as string
    assert.match(text, /^---\nname: workflow\n/)
    assert.deepEqual(entry.resources, [{ uri: entry.uri, digest: 'sha256:' + createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text) }])
    const got = await client.request({ method: 'skills/get', params: { uri: entry.uri } }, z.object({ skill: z.any() }).passthrough())
    assert.deepEqual(got.skill, entry)
    await assert.rejects(client.request({ method: 'skills/get', params: { uri: 'skill://nope/SKILL.md' } }, z.any()), (err: any) => err.code === -32602)
    await assert.rejects(client.readResource({ uri: 'skill://nope/SKILL.md' }), (err: any) => err.code === -32602)
  })
})

describe('mcp adapter over a composer (HTTP, both eras)', () => {
  const docs = new Map<string, unknown>([['https://idx.test/index.json', { version: 1, services: [{ id: 'pets', openapi: 'https://pets.test/openapi.json' }] }], ['https://pets.test/openapi.json', petstore]])
  const stackFetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (docs.has(url)) return new Response(JSON.stringify(docs.get(url)), { headers: { 'content-type': 'application/json', etag: `"${JSON.stringify(docs.get(url)).length}"` } })
    return fetchFn(input)
  }) as typeof fetch
  let http: HttpServer
  let url: URL
  let composer: Awaited<ReturnType<typeof createComposer>>
  const contexts: (Request | undefined)[] = []

  before(async () => {
    composer = await createComposer('https://idx.test/index.json', { fetch: stackFetch })
    const handler = createMcpHttpHandler(composer, INFO, {
      context: (request) => { contexts.push(request); return { headers: { cookie: request?.headers.get('cookie') ?? '' }, identity: request?.headers.get('cookie') ?? undefined } },
      refreshMs: 60_000
    })
    http = createServer(toNodeHandler(handler))
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    url = new URL(`http://127.0.0.1:${(http.address() as any).port}/mcp`)
  })
  after(() => http.close())

  const connect = async (mode: 'legacy' | 'auto', target = url, headers: Record<string, string> = {}, listChanged?: () => void) => {
    const client = new Client({ name: 'c', version: '0' }, {
      versionNegotiation: { mode },
      ...(listChanged ? { listChanged: { tools: { debounceMs: 0, onChanged: () => listChanged() } } } : {})
    })
    await client.connect(new StreamableHTTPClientTransport(target, { requestInit: { headers } }))
    return client
  }

  it('serves a 2025 client unchanged', async () => {
    const client = await connect('legacy')
    assert.equal(client.getProtocolEra(), 'legacy')
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    await client.close()
  })
  it('serves a 2026-07-28 client with cache hints', async () => {
    const client = await connect('auto')
    assert.equal(client.getProtocolEra(), 'modern')
    const list = await client.listTools()
    assert.equal(list.ttlMs, 60_000)
    assert.equal(list.cacheScope, 'private')
    assert.equal(client.getInstructions(), (await composer.compose()).toolSet.instructions)
    await client.close()
  })
  it('selects the profile set from ?profiles= and rejects an undeclared one', async () => {
    const client = await connect('auto', new URL(`${url}?profiles=edit`))
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_create_pet'])
    await client.close()
    await assert.rejects(async () => {
      const c = await connect('legacy', new URL(`${url}?profiles=nope`))
      await c.listTools()
    }, /unknown profile "nope"/)
  })
  it('hands the request to the context hook and forwards the derived headers upstream', async () => {
    upstream.length = 0
    const client = await connect('auto', url, { cookie: 'id_token=abc' })
    await client.callTool({ name: 'pets_list_pets', arguments: {} })
    assert.equal(upstream.at(-1)!.headers.get('cookie'), 'id_token=abc')
    assert.ok(contexts.some(r => r?.headers.get('cookie') === 'id_token=abc'))
    await client.close()
  })
  it('notifies a modern client when a refresh changes the set', async () => {
    let fired = () => {}
    const changed = new Promise<void>(resolve => { fired = resolve })
    const client = await connect('auto', url, {}, () => fired())
    await client.listTools()
    docs.set('https://pets.test/openapi.json', { ...petstore, paths: { ...petstore.paths, '/pets': { ...petstore.paths['/pets'], get: { ...petstore.paths['/pets'].get, 'x-agent': { ...petstore.paths['/pets'].get['x-agent'], name: 'find_pets' } } } } })
    assert.equal(await composer.refresh(), true)
    await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('no tools/list_changed within 2s')), 2000))])
    const { tools } = await client.listTools()
    assert.ok(tools.some(t => t.name === 'pets_find_pets'))
    await client.close()
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/adapters-mcp.test.ts`
Expected: import errors (`createMcpHttpHandler` missing; the old adapter imports the removed SDK).

- [ ] **Step 4: Rewrite the adapter**

`src/adapters/mcp.ts`:

```ts
import {
  Server, createMcpHandler, fromJsonSchema, ProtocolError, INVALID_PARAMS,
  type ServerOptions, type McpServerFactory, type McpHttpHandler, type CreateMcpHandlerOptions, type CacheHint
} from '@modelcontextprotocol/server'
import { renderSkillFile, type SkillFile } from '../skills.ts'
import type { Composer, Composition } from '../compose.ts'
import type { CallContext, ToolSet } from '../types.ts'

export type ToolSource = ToolSet | Composition | Composer

export interface McpAdapterOptions {
  /** derive the per-call context from the HTTP request; absent on stdio, where identity is the environment */
  context?: (request: Request | undefined) => CallContext | undefined
  /** the profile set when the request carries none (`?profiles=` absent, or stdio) */
  profiles?: string[]
  /** how often the caller refreshes the composition; advertised as `ttlMs` on cacheable results */
  refreshMs?: number
}

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
const DEFAULT_REFRESH_MS = 300_000

const isComposer = (s: ToolSource): s is Composer => typeof (s as Composer).compose === 'function'
const isComposition = (s: ToolSource): s is Composition => !isComposer(s) && typeof (s as Composition).onChange === 'function'

/** The `profiles` query parameter as a set, or undefined when absent. */
export function requestProfiles (request: Request | undefined): string[] | undefined {
  const raw = request ? new URL(request.url).searchParams.get('profiles') : null
  if (!raw) return undefined
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

export async function resolveToolSet (source: ToolSource, profiles?: string[]): Promise<ToolSet> {
  if (isComposer(source)) return (await source.compose(profiles)).toolSet
  if (isComposition(source)) return source.toolSet
  return source
}

export function serverOptions (toolSet: ToolSet, refreshMs: number): ServerOptions {
  const hint: CacheHint = { ttlMs: refreshMs, cacheScope: 'private' }
  return {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, extensions: { [SKILLS_EXTENSION]: {} } },
    instructions: toolSet.instructions || undefined,
    cacheHints: { 'tools/list': hint, 'resources/list': hint, 'resources/read': hint, 'server/discover': hint }
  }
}

const skillEntry = (s: SkillFile) => ({ uri: s.uri, frontmatter: s.frontmatter, resources: [{ uri: s.uri, digest: s.digest, size: s.size }] })

/** Register tools, resources and the skills extension on a low-level server, for one caller. */
export function toMcpServer (toolSet: ToolSet, server: Server, options: { ctx?: CallContext, refreshMs?: number } = {}): void {
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS
  const skills = toolSet.skills.map(renderSkillFile)
  const byUri = new Map(skills.map(s => [s.uri, s]))

  server.setRequestHandler('tools/list', async () => ({
    tools: toolSet.tools.map(t => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as any,
      outputSchema: t.outputSchema as any,
      annotations: t.annotations,
      _meta: t.examples ? { 'anthropic/inputExamples': t.examples } : undefined
    }))
  }))
  server.setRequestHandler('tools/call', async (req) => {
    const tool = toolSet.tools.find(t => t.name === req.params.name)
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] }
    const result = await tool.execute(req.params.arguments ?? {}, options.ctx)
    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result.isError ? { isError: true } : {})
    }
  })
  server.setRequestHandler('resources/list', async () => ({
    resources: skills.map(s => ({ uri: s.uri, name: s.frontmatter.name, description: s.frontmatter.description, mimeType: 'text/markdown' }))
  }))
  server.setRequestHandler('resources/read', async (req) => {
    const s = byUri.get(req.params.uri)
    if (!s) throw new ProtocolError(INVALID_PARAMS, `No resource is served at ${req.params.uri}`)
    return { contents: [{ uri: s.uri, mimeType: 'text/markdown', text: s.text }] }
  })
  // The extension's two methods, on the base Resources primitive (SEP-2640). Custom methods
  // do not receive the SDK's cache hints, so the fields are set on the result directly.
  const cache = { ttlMs: refreshMs, cacheScope: 'private' as const }
  server.setRequestHandler('skills/list', { params: fromJsonSchema({ type: 'object', properties: { cursor: { type: 'string' } } }) }, async () => ({
    skills: skills.map(skillEntry), ...cache
  }))
  server.setRequestHandler('skills/get', { params: fromJsonSchema<{ uri: string }>({ type: 'object', required: ['uri'], properties: { uri: { type: 'string' } } }) }, async (params) => {
    const s = byUri.get(params.uri)
    if (!s) throw new ProtocolError(INVALID_PARAMS, `No skill is served at ${params.uri}`)
    return { skill: skillEntry(s), ...cache }
  })
}

/** One server for one caller: the request's profile set and context, or the options' defaults. */
export async function createMcpServer (source: ToolSource, info: { name: string, version: string }, options: McpAdapterOptions & { request?: Request } = {}): Promise<Server> {
  const toolSet = await resolveToolSet(source, requestProfiles(options.request) ?? options.profiles)
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS
  const server = new Server(info, serverOptions(toolSet, refreshMs))
  toMcpServer(toolSet, server, { ctx: options.context?.(options.request), refreshMs })
  return server
}

/** The per-request factory both SDK entries (`createMcpHandler`, `serveStdio`) take. */
export function mcpServerFactory (source: ToolSource, info: { name: string, version: string }, options: McpAdapterOptions = {}): McpServerFactory {
  return (ctx) => createMcpServer(source, info, { ...options, request: ctx.requestInfo })
}

/** An HTTP handler serving both protocol eras, publishing change notifications from a live source. */
export function createMcpHttpHandler (source: ToolSource, info: { name: string, version: string }, options: McpAdapterOptions & CreateMcpHandlerOptions = {}): McpHttpHandler {
  const { context, profiles, refreshMs, ...handlerOptions } = options
  const handler = createMcpHandler(mcpServerFactory(source, info, { context, profiles, refreshMs }), handlerOptions)
  if (isComposer(source) || isComposition(source)) {
    source.onChange(() => { handler.notify.toolsChanged(); handler.notify.resourcesChanged() })
  }
  return handler
}
```

If `fromJsonSchema<{ uri: string }>` does not narrow `params` as written, type the handler's parameter explicitly: `async (params: { uri: string }) => …`.

`src/bin/server.ts` — compile-only migration (keep behaviour; Task 8 adds features):

```ts
#!/usr/bin/env node
import { createServer } from 'node:http'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { load } from '../load.ts'
import { createMcpHttpHandler, mcpServerFactory } from '../adapters/mcp.ts'

// … env, fetchFn and `const toolSet = await load(...)` unchanged (PROFILE still read here; Task 8 changes it)
const info = { name: 'openapi-mcp', version: '0.2.0' }

if ((env.TRANSPORT ?? 'stdio') === 'http') {
  const port = Number(env.PORT ?? 8080)
  const handler = createMcpHttpHandler(toolSet, info)
  createServer(toNodeHandler(handler)).listen(port, () => console.error(`openapi-mcp listening on http://0.0.0.0:${port} (${toolSet.tools.length} tools, profiles ${toolSet.profiles.join(',')})`))
} else {
  serveStdio(mcpServerFactory(toolSet, info))
  console.error(`openapi-mcp ready on stdio (${toolSet.tools.length} tools, profiles ${toolSet.profiles.join(',')})`)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run quality`
Expected: green, including `test/bin.test.ts` (stdio through `serveStdio`) and `test/evals/arms.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/adapters/mcp.ts src/bin/server.ts evals/arms.ts test/adapters-mcp.test.ts test/bin.test.ts
git commit -m "feat: MCP adapter on SDK v2 — per-request servers, both eras, skills extension"
```

---

### Task 8: The binary — index, profile sets, refresh

**Files:**
- Modify: `src/bin/server.ts`
- Test: `test/bin.test.ts`

**Interfaces:**
- Consumes: `createComposer`, `load`, `createMcpHttpHandler`, `mcpServerFactory`, `resolveToolSet`.
- Environment: `INDEX_URL` | `OPENAPI_URL` (exactly one), `PROFILES` (comma list; `PROFILE` accepted when `PROFILES` is absent), `LOCALE`, `BASE_URL`, `TRANSPORT`, `PORT`, `API_KEY_HEADER`, `API_KEY`, `STRUCTURED_CONTENT`, `LINT` (`error` | `warn` | `off`), `REFRESH_INTERVAL` (seconds, default `300`, `0` disables).

- [ ] **Step 1: Write the failing tests**

Extend `test/bin.test.ts`. Make the fixture API serve an index and two documents, and add two cases:

```ts
import { createServer as createNetServer } from 'node:net'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
const vetstore = JSON.parse(await readFile(new URL('./fixtures/vetstore.json', import.meta.url), 'utf8'))

// in the api handler, before the catch-all:
  if (req.url === '/index.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ version: 1, services: [{ id: 'pets', openapi: `http://127.0.0.1:${port}/openapi.json` }, { id: 'vets', openapi: `http://127.0.0.1:${port}/vets.json` }] }))
  }
  if (req.url === '/vets.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ...vetstore, servers: [{ url: `http://127.0.0.1:${port}/api` }] }))
  }

const freePort = () => new Promise<number>(resolve => { const s = createNetServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)) }) })
const bin = fileURLToPath(new URL('../src/bin/server.ts', import.meta.url))

  it('composes an index over stdio with a profile set', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      env: { ...process.env, INDEX_URL: `http://127.0.0.1:${port}/index.json`, PROFILES: 'explore,edit', TRANSPORT: 'stdio', REFRESH_INTERVAL: '0' }
    })
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(transport)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(t => t.name), ['pets_list_pets', 'pets_create_pet', 'pets_get_pet', 'vets_list_vets', 'vets_create_appointment'])
    await client.close()
  })

  it('serves an index over HTTP, selecting profiles per request', async () => {
    const httpPort = await freePort()
    const child = spawn(process.execPath, [bin], {
      env: { ...process.env, INDEX_URL: `http://127.0.0.1:${port}/index.json`, TRANSPORT: 'http', PORT: String(httpPort), REFRESH_INTERVAL: '0' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    await new Promise<void>((resolve, reject) => {
      child.stderr.on('data', (d: Buffer) => { if (d.toString().includes('listening')) resolve() })
      child.on('exit', code => reject(new Error(`bin exited with ${code}`)))
    })
    try {
      const client = new Client({ name: 'test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } })
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp?profiles=edit`)))
      const { tools } = await client.listTools()
      assert.deepEqual(tools.map(t => t.name), ['pets_create_pet', 'vets_create_appointment'])
      await client.close()
    } finally {
      child.kill()
    }
  })
```

with `import { spawn } from 'node:child_process'` at the top. Keep the existing stdio test; its `PROFILE` is unset so nothing changes.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/bin.test.ts`
Expected: the two new cases fail (`INDEX_URL` is ignored: "OPENAPI_URL is required").

- [ ] **Step 3: Implement**

Rewrite `src/bin/server.ts`:

```ts
#!/usr/bin/env node
import { createServer } from 'node:http'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import type { Server } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { load } from '../load.ts'
import { createComposer, type Composer } from '../compose.ts'
import { createMcpHttpHandler, mcpServerFactory, resolveToolSet, type ToolSource } from '../adapters/mcp.ts'

const env = process.env
const indexUrl = env.INDEX_URL
const openapiUrl = env.OPENAPI_URL
if (!indexUrl === !openapiUrl) {
  console.error('exactly one of INDEX_URL or OPENAPI_URL is required')
  process.exit(1)
}

const profiles = (env.PROFILES ?? env.PROFILE)?.split(',').map(s => s.trim()).filter(Boolean)
const refreshMs = Number(env.REFRESH_INTERVAL ?? 300) * 1000
const lint = (env.LINT ?? 'error') as 'error' | 'warn' | 'off'

// The single-credential convenience: a fixed header on every upstream request. Anything
// richer lives outside this binary — nhi-proxy through the environment, or a server's
// context hook.
const apiKeyHeader = env.API_KEY_HEADER
const apiKey = env.API_KEY
const fetchFn: typeof fetch = (input, init) => {
  const req = new Request(input, init)
  if (apiKeyHeader && apiKey) req.headers.set(apiKeyHeader, apiKey)
  return fetch(req)
}

const options = {
  locale: env.LOCALE ?? 'en',
  baseUrl: env.BASE_URL,
  structuredContent: env.STRUCTURED_CONTENT === 'true',
  lint,
  fetch: fetchFn
}

let source: ToolSource
let composer: Composer | undefined
if (indexUrl) {
  composer = await createComposer(indexUrl, options)
  for (const s of composer.services) if (s.status !== 'ok') console.error(`service ${s.id}: ${s.status}${s.reason ? ` — ${s.reason}` : ''}`)
  source = composer
} else {
  source = await load(openapiUrl!, { ...options, profiles })
}
const info = { name: 'openapi-mcp', version: '0.2.0' }
const describe = async () => {
  const ts = await resolveToolSet(source, profiles)
  return `${ts.tools.length} tools, ${ts.skills.length} skills, profiles ${ts.profiles.join(',')}`
}

// The library never runs a timer; this binary does, and only over an index.
if (composer && refreshMs > 0) {
  setInterval(() => composer!.refresh().catch((err: unknown) => console.error('refresh failed:', err)), refreshMs).unref()
}

if ((env.TRANSPORT ?? 'stdio') === 'http') {
  const port = Number(env.PORT ?? 8080)
  const handler = createMcpHttpHandler(source, info, { profiles, refreshMs: refreshMs || undefined })
  createServer(toNodeHandler(handler)).listen(port, async () => console.error(`openapi-mcp listening on http://0.0.0.0:${port} (${await describe()})`))
} else {
  // One stdio connection is one caller; the era-pinned instance the factory returns is
  // the one to notify when a refresh changes the set.
  let pinned: Server | undefined
  const factory = mcpServerFactory(source, info, { profiles, refreshMs: refreshMs || undefined })
  serveStdio(async (ctx) => { pinned = await factory(ctx) as Server; return pinned })
  composer?.onChange(() => pinned?.sendToolListChanged().catch(() => {}))
  console.error(`openapi-mcp ready on stdio (${await describe()})`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run quality`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/bin/server.ts test/bin.test.ts
git commit -m "feat: the binary composes an index, selects profile sets and refreshes"
```

---

### Task 9: Documentation, skill, version

**Files:**
- Modify: `README.md`, `CONTRIBUTING.md`, `docs/x-agent.md`, `skills/openapi-mcp/SKILL.md`, `package.json` (`version`)

- [ ] **Step 1: README**

Replace the **Standalone server** table and add sections. Exact content:

Table rows (replace the existing table):

```
| Env var             | Required | Default | Description                                                          |
| ------------------- | -------- | ------- | -------------------------------------------------------------------- |
| `INDEX_URL`         | one of   |         | URL of a deployment index listing service-level OpenAPI documents    |
| `OPENAPI_URL`       | one of   |         | URL of a single OpenAPI document                                     |
| `PROFILES`          | no       |         | Comma-separated profile set; the document's default profile otherwise |
| `REFRESH_INTERVAL`  | no       | `300`   | Seconds between conditional re-fetches of the index and documents; `0` disables |
| `LINT`              | no       | `error` | `error`, `warn` or `off` — see Annotation lint                        |
| `LOCALE`            | no       | `en`    | Locale used to resolve localized text                                |
| `BASE_URL`          | no       |         | Overrides `servers[0].url` from the document                         |
| `TRANSPORT`         | no       | `stdio` | `stdio` or `http`                                                    |
| `PORT`              | no       | `8080`  | Port to listen on when `TRANSPORT=http`                              |
| `API_KEY_HEADER`    | no       |         | Header name added to every upstream request                          |
| `API_KEY`           | no       |         | Value sent in `API_KEY_HEADER`                                       |
| `STRUCTURED_CONTENT`| no       | `false` | Set to `true` to also return `structuredContent` from tool calls     |
```

Add after the table:

```markdown
In HTTP mode a request's `?profiles=explore,edit` selects the set for that request. HTTP
mode here is single-identity and stateless: it is for development. A deployed server
that serves several callers forwards each caller's identity per call through the
adapter's context hook — that is `data-fair/mcp` v2, not this binary.

### Coding agents behind nhi-proxy

Identity comes from the environment; the binary implements nothing for it:

```sh
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7331 \
NODE_EXTRA_CA_CERTS=~/.config/nhi-proxy/koumoul.com/ca.crt \
INDEX_URL=https://koumoul.com/data-fair/api/v1/agents/index.json PROFILES=explore,edit openapi-mcp
```

## Composing a deployment

An index lists a deployment's service-level documents; `createComposer` merges them into
one tool set per profile set, over one document cache:

```ts
import { createComposer } from '@data-fair/openapi-mcp'
import { createMcpHttpHandler } from '@data-fair/openapi-mcp/adapters/mcp'

const composer = await createComposer('https://host/data-fair/api/v1/agents/index.json', { locale: 'fr' })
composer.profiles()                       // every declared profile, expanded, with the index's wording
const c = await composer.compose(['explore', 'edit'])
c.toolSet.tools                           // each operation once, index order then document order
c.services                                // [{ id, status: 'ok' | 'skipped' | 'error', tools, reason? }]
setInterval(() => composer.refresh(), 300_000)   // conditional GETs; the library runs no timer

const handler = createMcpHttpHandler(composer, { name: 'my-server', version: '1.0.0' }, {
  context: (request) => ({ headers: { cookie: request?.headers.get('cookie') ?? '' }, identity: request?.headers.get('cookie') ?? undefined })
})
```

The index is the one document this library dictates:

```json
{
  "version": 1,
  "services": [{ "id": "data-fair", "openapi": "https://host/data-fair/api/v1/api-docs.json" }],
  "profiles": { "full": { "title": "Full", "includes": ["explore", "edit"] } },
  "skills": [{ "name": "publishing-workflow", "description": "…", "profiles": ["edit"] }]
}
```

A failing service is excluded and reported; only a bad index throws. Tool names must be
unique across services (`namePrefix` is how); on a collision the later service is excluded.

## Identity per call

`Tool.execute(params, ctx)` takes a `CallContext` — `fetch`, `headers`, `signal`,
`identity`. The library never reads a cookie or holds a credential: a server derives the
context from the request it serves, a page passes its own `fetch`, the binary relies on the
environment. `identity` partitions json-layout editor sessions per caller.

## Skills

`x-agent.skills` (and an index's `skills`) are served as resources through the official
skills extension (`io.modelcontextprotocol/skills`): `skills/list`,
`skills/get`, and `resources/read` of `skill://<service-id>/<name>/SKILL.md`, with a
SHA-256 manifest. Skill names follow the Agent Skills format (`^[a-z0-9]+(-[a-z0-9]+)*$`).
The same text still renders into `instructions`, so clients without the extension lose
nothing.

## Per-service golden

`toolSetSnapshot(toolSet)` is the agent-facing surface as plain data. A service's CI
loads its own document with `lint: 'error'` for every declared profile and diffs the
snapshot against a committed golden, so a change to a tool's name, description or schema
is a reviewable diff in the pull request that caused it.
```

Also update the library example at the top: `load(url, { profile: 'explore' })` → `load(url, { profiles: ['explore'] })`, and `{ profile, instructions, tools }` → `{ profiles, instructions, tools, skills }`.

- [ ] **Step 2: `docs/x-agent.md`**

In **Root**, extend the YAML example and bullets:

```yaml
  profiles:
    explore: { title: Explore, description: Read-only tools }
    write_datasets: { title: Edit datasets }
    write: { title: Edit, includes: [write_datasets] }
```

- `profiles` bullet: add "`includes` names other declared profiles: requesting this one also selects their operations. Expanded transitively; a cycle or an undeclared name refuses the document."
- `skills` bullet: add "A skill's `name` follows the Agent Skills format (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters), because the MCP skills extension serves it under `skill://…/<name>/SKILL.md`. The first paragraph of `description` becomes the SKILL.md description (capped at 1024 characters); the whole text is the body."

Add a section **Recommended profile names** after **Root**:

```markdown
## Recommended profile names

A consumer asks every service of a deployment for the same profile names, so the same name
should mean the same thing everywhere:

- `explore` — read-only: listing, describing, querying.
- `edit` — everything `explore` has, plus writes an ordinary user of the service performs. Per-resource
  subsets (`edit_datasets`, `edit_applications`) are declared and `edit` `includes` them.
- `admin` — operations reserved to administrators.

A service that has nothing for a name simply does not declare it; a consumer requesting it
gets that service's contribution to the other names in the set. Convention, not validation.
```

In **Loading**: replace `profile` with `profiles` (`load(spec, { profiles: ['explore', 'edit'] })` — "an operation in any requested profile, after `includes` expansion, is selected once; `profile` remains as one-element sugar") and add "The result carries `skills`, the text-only skills selected by the profile set."

- [ ] **Step 3: `skills/openapi-mcp/SKILL.md`**

In **Reference** (or the root annotation subsection), add the skill-name rule and `includes`, both one line each, mirroring `docs/x-agent.md`. Add a subsection before **Common failure modes**:

```markdown
## Guard the agent-facing surface in CI

Every annotated service commits a golden of its tool surface and diffs it on each run:

```ts
import { load, toolSetSnapshot } from '@data-fair/openapi-mcp'
const doc = buildApiDocs('https://example.test')          // the service's own generator
for (const profile of Object.keys(doc['x-agent'].profiles)) {
  const snapshot = toolSetSnapshot(await load(doc, { profiles: [profile], lint: 'error' }))
  assert.deepEqual(snapshot, JSON.parse(readFileSync(`test/golden/agent-tools.${profile}.json`, 'utf8')))
}
```

`lint: 'error'` refuses a description that contradicts its schema; the golden turns a renamed
tool, a widened schema or a dropped parameter into a diff the reviewer sees.
```

- [ ] **Step 4: `CONTRIBUTING.md` layout and version**

Add to the layout block: `compose.ts    index → composer → compositions`, `profiles.ts   includes expansion, set selection`, `context.ts    per-call context`, `skills.ts     SKILL.md rendering`, `snapshot.ts   toolSetSnapshot`, `index-contract.ts  the index document`. Set `"version": "0.2.0"` in `package.json` and in `src/bin/server.ts`'s `info` (already `0.2.0` from Task 7).

Add one line at the end of the spec's §3 (`docs/superpowers/specs/2026-09-22-stack-composition-design.md`): "*Implementation note:* `compose()` returns a `Promise<Composition>` — `load()` is asynchronous (editor groups import their peer lazily), so a composition cannot be built synchronously; memoization is per set on the promise."

- [ ] **Step 5: Verify and commit**

Run: `npm run quality`
Expected: green (docs do not affect tests; the gate confirms nothing else moved).

```bash
git add README.md CONTRIBUTING.md docs/x-agent.md skills/openapi-mcp/SKILL.md package.json docs/superpowers/specs/2026-09-22-stack-composition-design.md
git commit -m "docs: composition, per-call context, skills extension, per-service golden; 0.2.0"
```

---

### Task 10: Eval arm C — the composed set over an index

**Files:**
- Modify: `evals/fixture-server.ts`, `evals/arms.ts`, `evals/run.ts:31-36,151-153`
- Test: `test/evals/arms.test.ts`

**Interfaces:**
- Consumes: the binary's `INDEX_URL` / `PROFILES` (Task 8).
- Produces: `export type ArmName = 'A' | 'B' | 'C'`, `export function armC (indexUrl: string, fixtureHash: string): ArmSpec`, `startFixtureServer()` result gains `indexUrl: string`.

- [ ] **Step 1: Write the failing test**

Add to `test/evals/arms.test.ts` (next to the existing arm B case, which asserts `b.provenance.profile`):

```ts
  it('arm C runs the binary over an index with the explore profile', () => {
    const c = armC('http://127.0.0.1:1/index.json', 'abc123')
    assert.equal(c.name, 'C')
    assert.equal(c.serverName, 'datafair')
    assert.deepEqual(c.config.env, { INDEX_URL: 'http://127.0.0.1:1/index.json', PROFILES: 'explore', REFRESH_INTERVAL: '0' })
    assert.deepEqual(c.provenance, { fixtureHash: 'abc123', profiles: 'explore', composed: 'true' })
  })
```

with `armC` added to the file's import from `../../evals/arms.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/evals/arms.test.ts`
Expected: `armC` is not exported.

- [ ] **Step 3: Implement**

`evals/fixture-server.ts` — serve the index next to the document:

```ts
  const server = createServer((req, res) => {
    if (req.url === '/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ version: 1, services: [{ id: 'data-fair', openapi: `http://127.0.0.1:${(server.address() as { port: number }).port}/openapi.json` }] }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
  })
  // …
  return {
    url: `http://127.0.0.1:${port}/openapi.json`,
    indexUrl: `http://127.0.0.1:${port}/index.json`,
    hash,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
```

`evals/arms.ts`:

```ts
export type ArmName = 'A' | 'B' | 'C'

export function armB (openapiUrl: string, fixtureHash: string): ArmSpec {
  return {
    name: 'B',
    serverName: SERVER_NAME,
    config: { command: 'node', args: [resolve(repoRoot, 'src/bin/server.ts')], env: { OPENAPI_URL: openapiUrl, PROFILES: 'explore' } },
    provenance: { fixtureHash, profile: 'explore' }
  }
}

/** The same document reached through an index and the composer: parity with B is the expectation. */
export function armC (indexUrl: string, fixtureHash: string): ArmSpec {
  return {
    name: 'C',
    serverName: SERVER_NAME,
    config: { command: 'node', args: [resolve(repoRoot, 'src/bin/server.ts')], env: { INDEX_URL: indexUrl, PROFILES: 'explore', REFRESH_INTERVAL: '0' } },
    provenance: { fixtureHash, profiles: 'explore', composed: 'true' }
  }
}
```

`evals/run.ts`:

```ts
import { armA, armB, armC, discoverTools, type ArmSpec, type ArmName } from './arms.ts'
// line 31:
  let arm: ArmName | undefined
// line 36:
      if (raw !== 'A' && raw !== 'B' && raw !== 'C') throw new Error(`--arm must be A, B or C, got ${JSON.stringify(raw)}`)
// lines 151-153:
    const arms: ArmSpec[] = []
    if (!onlyArm || onlyArm === 'A') arms.push(armA(PORTAL_URL))
    if (!onlyArm || onlyArm === 'B') arms.push(armB(fixture.url, fixture.hash))
    if (!onlyArm || onlyArm === 'C') arms.push(armC(fixture.indexUrl, fixture.hash))
```

Check `evals/report.ts` and `evals/judge.ts` for a hard-coded `'A' | 'B'` (`grep -n "'B'" evals/*.ts`) and widen any to `ArmName`.

- [ ] **Step 4: Run the tests, then a discovery smoke**

Run: `npm run quality`
Expected: green.

Run: `node --input-type=module -e "import { startFixtureServer } from './evals/fixture-server.ts'; import { armC, discoverTools } from './evals/arms.ts'; const f = await startFixtureServer(); const d = await discoverTools(armC(f.indexUrl, f.hash)); console.log(d.toolNames); await f.close()"`
Expected: the six `explore` tool names of the annotated data-fair document, prefixed by the server name the same way arm B prints them.

Running the scenarios (`npm run eval -- --arm C`) needs the model credentials the harness documents in `CONTRIBUTING.md`; it is the verification of the spec's "parity with B" claim and is run by whoever has them, with the report's tool-definition-token column as the number to watch. Record the run under `evals/baselines/` as the existing arms are.

- [ ] **Step 5: Commit**

```bash
git add evals/fixture-server.ts evals/arms.ts evals/run.ts test/evals/arms.test.ts
git commit -m "feat(evals): arm C — the composed set over an index"
```

---

## Self-Review

**Spec coverage.**
- §2 index contract → Task 6 (`index-contract.ts`, `version`, id pattern, uniqueness, `profiles`, `skills`; no `indexes`). Public/private URLs and session independence are obligations on data-fair, stated in the README text of Task 9 only implicitly — acceptable, they are not code here.
- §3 composer → Task 6 (loading, partial sets, skipped/error, collision → later service, instructions layout, skills with `<service-id>/` ids, refresh with conditional GETs and per-composition `onChange`, composer-level `onChange`, memoization per set, `profiles()` with index wording winning, default profile). `compose()` returns a promise — a deviation from the spec's sketch, justified in Task 6 and noted in the spec by Task 9.
- §4 per-call context → Task 3 (resolution order, header override, identity-keyed editor sessions, session fetch through the call in progress; the library never reads a cookie — the context hook is the adapter's option, implemented by the server).
- §5 adapter → Task 7 (SDK v2, factory per request, `?profiles=` selection with an error for an undeclared profile, both eras, `ttlMs`/`cacheScope` on the cacheable methods and on the two skills methods, `toolsChanged` + `resourcesChanged` from `onChange`, skills extension with real digests, `resources/read`, `-32602`, no prompts, `_meta` examples kept).
- §6 binary → Task 8 (`INDEX_URL` | `OPENAPI_URL`, `PROFILES` with `PROFILE` tolerated, `REFRESH_INTERVAL`, `LINT`, `?profiles=` per request, timer in the bin only, nhi-proxy recipe in README via Task 9).
- §7 vocabulary → Task 1 (`includes`, cycle and undeclared refusal, skill name rule), Task 5 (`toolSetSnapshot`), Task 9 (recommended profile names).
- §8 testing → each task's tests; per-service pattern in Task 9's skill text; eval arm C in Task 10.
- §9 roadmap step 1 → Tasks 1–10 in dependency order. `export-skills` deferred as the spec says.

**Placeholder scan.** No TBDs; every code step carries its code. Task 6's `build` is asynchronous throughout, and the tests await `compose()`.

**Type consistency.** `resolveOperations(doc, string | string[])` (Task 2) is what Task 6 relies on through `load()`. `ToolSet` gains `profiles` in Task 2 and `skills` in Task 4; Task 5's snapshot and Task 6's composer use both. `Tool.execute(params, ctx?)` (Task 3) is what Task 7's `tools/call` passes `options.ctx` to. `Composer.compose` returns a promise everywhere after Task 6's correction — Task 7's `resolveToolSet` and Task 8's `describe()` await it. `renderSkillFile` returns `{ uri, frontmatter, text, digest, size }` (Task 4), consumed by Task 7's `skillEntry`. `createMcpHttpHandler`'s options split `context`/`profiles`/`refreshMs` from the SDK's handler options (Task 7), matching Task 8's calls.
