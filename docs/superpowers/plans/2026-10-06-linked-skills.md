# Linked Skills and Progressive Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a skill's body live in a linked markdown file, keep only names and descriptions in the MCP instructions, and serve bodies through one generated `read_skill` tool and the existing skill resources.

**Architecture:** `src/skills.ts` becomes the one place that resolves skill entries (inline or linked body, frontmatter stripped, digest), renders their instructions entries and builds the `read_skill` tool. `load()` resolves the document's skills against the document URL and appends the tool; the composer resolves through a conditional-request cache shared by every composition, revalidated on `refresh()`, and adds a single `read_skill` for the merged set. Validation enforces the Agent Skills split: a short `description`, the body in `body` or `href`.

**Tech Stack:** TypeScript on Node 24 (type stripping), `node:test`, Ajv 2020, MCP SDK v2 adapter.

**Spec:** `docs/superpowers/specs/2026-10-06-linked-skills-design.md`

## Global Constraints

- `description`: "At most 1024 characters per locale — the Agent Skills limit — refused at validation otherwise."
- "`href` and `body` are mutually exclusive (refused at validation). A skill with neither has its description as its body."
- "No text is derived from paragraphs any more: the first-paragraph heuristic is removed."
- "A relative `href` resolves against the URL the document (or index) was fetched from. For a document passed as an object, it resolves against `servers[0].url` (or the `baseUrl` option)." — the server URL is treated as a directory (a trailing `/` is added), so `…/api/v1` + `agents/skills/x.md` gives `…/api/v1/agents/skills/x.md`.
- "A body file may start with a YAML frontmatter block; it is stripped."
- "A body that cannot be fetched … does not fail the service."
- "No body is ever rendered into the instructions."
- `read_skill`: "Fixed, unprefixed name", input `name` as `oneOf` of `{ const: <id>, description }`, annotations `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`; "a composition has exactly one".
- Snapshot skill entries gain `digest` (`sha256:` over the body).
- Tag-level `x-agent.skill` texts are unchanged.
- Work on branch `feat/linked-skills` (from `feat/editor-skill`). Tests: `NODE_ENV=test node --test --test-force-exit test/*.test.ts test/evals/*.test.ts`; `test/evals/arms.test.ts` "arm A" fails before this work (it launches the `~/data-fair/mcp` checkout) and is not a regression. Gate: `npm run lint && npm run check-types` plus the tests.

## Review Focus

1. A linked body changes upstream while a composer runs → after `refresh()` the digest changes and listeners are notified; an unchanged body (304) notifies nothing. (Task 4)
2. A relative `href` in a document passed as an object with `servers[0].url` ending in a path segment (`…/api/v1`) → resolved under that segment, not beside it. (Task 3)
3. A skill body unreachable (404) → service still serves its tools; `read_skill` answers `isError` naming the URL; the skill is absent from `skills/list`; the composer-level status carries the warning. (Tasks 3, 4, 5)
4. A service declaring an operation tool named `read_skill` → that service is excluded with an error status in a composition, and `load()` refuses when the document has skills. (Tasks 3, 4)
5. A composition with skills from several services and the index → one `read_skill` whose `oneOf` lists every skill id with its service prefix. (Task 4)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types.ts` | vocabulary and result types | `AgentSkill.href/body`, `Skill.digest/error`, `ToolSet.guide`, `SkillBodyFetcher` |
| `src/vocabulary/schema.ts`, `src/index-contract.ts` | validation | short `description`, `href`, `body`, exclusivity |
| `src/skills.ts` | resolve, render, tool | `resolveSkills`, `defaultSkillFetcher`, `digestOf`, `skillEntries`, `skillTool`, `SKILL_TOOL` |
| `src/load.ts` | single document | skill resolution, instructions, `guide`, `read_skill` |
| `src/compose.ts` | deployment | skill body cache, refresh, single `read_skill`, warnings |
| `src/snapshot.ts` | golden view | `digest` |
| `src/adapters/mcp.ts` | MCP serving | errored skills out of the manifest |
| `src/index.ts` | exports | new skills exports |
| `test/fixtures/data-fair-annotations.ts` | fixture | migrate the long description |
| tests | | per task |
| `docs/x-agent.md`, `README.md`, `skills/openapi-mcp/SKILL.md` | docs | linked skills, migration |

---

### Task 1: Vocabulary and validation

**Files:**
- Modify: `src/types.ts` (`AgentSkill`, around line 73), `src/vocabulary/schema.ts` (`rootSchema.properties.skills`), `src/index-contract.ts` (`indexSchema.properties.skills`), `test/fixtures/data-fair-annotations.ts`
- Test: `test/vocabulary.test.ts`, `test/index-contract.test.ts`

**Interfaces:**
- Produces: `AgentSkill = { name: string, description: Localized, href?: Localized, body?: Localized, profiles?: string[], tools?: string[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/vocabulary.test.ts`:

```ts
describe('skills: description, body and href', () => {
  const withSkills = (skills: unknown[]) => doc({ 'x-agent': { skills } })
  it('accepts a linked body, an inline body, or neither', () => {
    assert.doesNotThrow(() => validateVocabulary(withSkills([
      { name: 'a', description: 'When to use a.', href: 'agents/skills/a.md' },
      { name: 'b', description: { en: 'When to use b.', fr: 'Quand utiliser b.' }, body: { en: 'Do this.', fr: 'Faites ceci.' } },
      { name: 'c', description: 'Short enough to be its own body.' },
      { name: 'd', description: 'Localized link.', href: { en: 'skills/d.en.md', fr: 'skills/d.fr.md' } }
    ])))
  })
  it('refuses a description over 1024 characters, in any locale', () => {
    assert.throws(() => validateVocabulary(withSkills([{ name: 'a', description: 'x'.repeat(1025) }])), /x-agent invalid at \//)
    assert.throws(() => validateVocabulary(withSkills([{ name: 'a', description: { en: 'ok', fr: 'x'.repeat(1025) } }])), /x-agent invalid at \//)
  })
  it('refuses href and body together', () => {
    assert.throws(() => validateVocabulary(withSkills([{ name: 'a', description: 'd', href: 'a.md', body: 'b' }])), /x-agent invalid at \//)
  })
})
```

Append to `test/index-contract.test.ts` (it imports `validateIndex`; add the import if missing: `import { validateIndex } from '../src/index-contract.ts'`):

```ts
describe('index skills: description, body and href', () => {
  const index = (skills: unknown[]) => ({ version: 1, services: [{ id: 's', openapi: 'https://s.test/openapi.json' }], skills })
  it('accepts href or body', () => {
    assert.doesNotThrow(() => validateIndex(index([{ name: 'a', description: 'd', href: 'skills/a.md' }, { name: 'b', description: 'd', body: 'b' }])))
  })
  it('refuses a long description and href with body', () => {
    assert.throws(() => validateIndex(index([{ name: 'a', description: 'x'.repeat(1025) }])))
    assert.throws(() => validateIndex(index([{ name: 'a', description: 'd', href: 'a.md', body: 'b' }])))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test --test-name-pattern="description, body and href" test/vocabulary.test.ts test/index-contract.test.ts`
Expected: FAIL — `href`/`body` are unknown properties (first test of each), the long description and the pair are accepted.

- [ ] **Step 3: Implement**

`src/types.ts`, replace `interface AgentSkill`:

```ts
/**
 * A skill in the Agent Skills sense: `description` is what an agent reads to decide whether the
 * skill applies (always shown, at most 1024 characters); the body is read on demand, inline in
 * `body` or linked by `href` (relative to the document's URL). Neither: the description is the body.
 */
export interface AgentSkill {
  name: string
  description: Localized
  href?: Localized
  body?: Localized
  profiles?: string[]
  tools?: string[]
}
```

`src/vocabulary/schema.ts`: after `const localized …`, add:

```ts
/** The Agent Skills description limit, per locale. */
const shortLocalized: JsonSchema = {
  oneOf: [
    { type: 'string', maxLength: 1024 },
    { type: 'object', additionalProperties: { type: 'string', maxLength: 1024 }, minProperties: 1 }
  ]
}
```

and replace the skill item schema in `rootSchema.properties.skills.items` with:

```ts
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        // a body is inline or linked, never both
        not: { required: ['href', 'body'] },
        properties: {
          // The MCP skills extension requires `name` to equal the last URI segment and
          // delegates its format to the Agent Skills specification.
          name: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 },
          description: shortLocalized,
          href: localized,
          body: localized,
          profiles: { type: 'array', items: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' } }
        }
      }
```

`src/index-contract.ts`: add the same `shortLocalized` constant after its `localized` constant, and replace its skill item schema with the same object (without the two comment lines about the extension, which are specific to documents).

`test/fixtures/data-fair-annotations.ts`: in the `workflow` skill, rename the key `description:` (the long template string) to `body:`, and add before it:

```ts
    description: 'How to query French open data through Data Fair: find datasets, read their schema, then search, aggregate or compute metrics.',
```

- [ ] **Step 4: Run the tests**

Run: `NODE_ENV=test node --test --test-force-exit test/*.test.ts`
Expected: PASS (the fixture now validates; the first-paragraph tests in `test/skills.test.ts` still pass, since resolution has not changed yet).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/vocabulary/schema.ts src/index-contract.ts test/fixtures/data-fair-annotations.ts test/vocabulary.test.ts test/index-contract.test.ts
git commit -m "feat(vocabulary)!: skills take a short description and an inline or linked body"
```

---

### Task 2: Resolving skills, entries and the read_skill tool

**Files:**
- Modify: `src/types.ts` (`Skill`, `ToolSet`, new `SkillBodyFetcher`), `src/skills.ts`, `src/index.ts`
- Rewrite: `test/skills.test.ts`

**Interfaces:**
- Consumes: `AgentSkill` (Task 1).
- Produces (all exported from `src/skills.ts` and the package root):
  - `type SkillBodyFetcher = (url: string) => Promise<{ text: string } | { error: string }>` (in `types.ts`)
  - `Skill = { id, name, description, body, digest: string, error?: string, tools?, profiles? }`
  - `resolveSkills(skills: AgentSkill[] | undefined, selected: Set<string>, locale: string, base: string | undefined, fetchBody: SkillBodyFetcher): Promise<Skill[]>`
  - `defaultSkillFetcher(fetchFn: typeof fetch): SkillBodyFetcher`
  - `digestOf(text: string): string`
  - `skillEntries(skills: Skill[]): string`
  - `SKILL_TOOL = 'read_skill'`, `skillTool(skills: Skill[]): Tool | undefined`
  - `editorSkill(...)` now also sets `digest`
  - `ToolSet.guide?: string` — the document's own sections (tag guides) without skill entries.

- [ ] **Step 1: Rewrite the tests**

Replace the content of `test/skills.test.ts` with:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveSkills, renderSkillFile, skillEntries, skillTool, digestOf, defaultSkillFetcher } from '../src/skills.ts'
import type { SkillBodyFetcher } from '../src/types.ts'

const files: Record<string, string> = {
  'https://api.test/v1/agents/skills/a.md': '---\nname: a\ndescription: ignored\n---\n\n# A\n\nDo this.\n',
  'https://api.test/v1/agents/skills/b.fr.md': 'Faites ceci.',
  'https://cdn.test/c.md': 'Absolute.'
}
const fetchBody: SkillBodyFetcher = async (url) => url in files ? { text: files[url] } : { error: 'HTTP 404' }
const base = 'https://api.test/v1/api-docs.json'

describe('resolveSkills', () => {
  it('reads an inline body, a linked body (frontmatter stripped), and falls back to the description', async () => {
    const skills = await resolveSkills([
      { name: 'inline', description: 'When inline.', body: 'Inline body.', tools: ['t1', 't2'] },
      { name: 'a', description: 'When a.', href: 'agents/skills/a.md' },
      { name: 'plain', description: 'Just this.' }
    ], new Set(['explore']), 'en', base, fetchBody)
    assert.deepEqual(skills.map(s => [s.id, s.description, s.body]), [
      ['inline', 'When inline.', 'Inline body.\n\nTools: t1, t2'],
      ['a', 'When a.', '# A\n\nDo this.'],
      ['plain', 'Just this.', 'Just this.']
    ])
    assert.equal(skills[1].digest, digestOf('# A\n\nDo this.'))
    assert.equal(skills[1].error, undefined)
  })
  it('resolves a localized link and an absolute one', async () => {
    const skills = await resolveSkills([
      { name: 'b', description: 'd', href: { en: 'agents/skills/b.en.md', fr: 'agents/skills/b.fr.md' } },
      { name: 'c', description: 'd', href: 'https://cdn.test/c.md' }
    ], new Set(), 'fr', base, fetchBody)
    assert.deepEqual(skills.map(s => s.body), ['Faites ceci.', 'Absolute.'])
  })
  it('keeps an unreachable skill with its error, and filters by profiles', async () => {
    const skills = await resolveSkills([
      { name: 'gone', description: 'd', href: 'nope.md' },
      { name: 'edit-only', description: 'd', profiles: ['edit'] }
    ], new Set(['explore']), 'en', base, fetchBody)
    assert.deepEqual(skills.map(s => [s.id, s.body, s.error]), [['gone', '', 'HTTP 404 (https://api.test/v1/nope.md)']])
  })
  it('refuses a relative link without a base URL, as an error on the skill', async () => {
    const [skill] = await resolveSkills([{ name: 'a', description: 'd', href: 'a.md' }], new Set(), 'en', undefined, fetchBody)
    assert.match(skill.error!, /no base URL/)
  })
})

describe('defaultSkillFetcher', () => {
  it('returns the text, or the HTTP status, or the network error', async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/ok.md')) return new Response('Body.', { headers: { 'content-type': 'text/markdown' } })
      if (url.endsWith('/missing.md')) return new Response('no', { status: 404 })
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const f = defaultSkillFetcher(fetchFn)
    assert.deepEqual(await f('https://x.test/ok.md'), { text: 'Body.' })
    assert.deepEqual(await f('https://x.test/missing.md'), { error: 'HTTP 404' })
    assert.deepEqual(await f('https://x.test/down.md'), { error: 'fetch failed: ECONNREFUSED' })
  })
})

describe('skillEntries', () => {
  it('renders name, description, tools and the read pointer, never the body', async () => {
    const skills = await resolveSkills([{ name: 'w', description: 'When w.', body: 'SECRET BODY', tools: ['t1'] }], new Set(), 'en', base, fetchBody)
    const text = skillEntries(skills.map(s => ({ ...s, id: 'svc/w' })))
    assert.equal(text, '## w\n\nWhen w.\n\nTools: t1\nRead it with read_skill("svc/w").')
    assert.doesNotMatch(text, /SECRET/)
  })
})

describe('skillTool', () => {
  it('is absent without skills', () => {
    assert.equal(skillTool([]), undefined)
  })
  it('lists every skill with its description, and returns the body or the error', async () => {
    const skills = await resolveSkills([
      { name: 'a', description: 'When a.', href: 'agents/skills/a.md' },
      { name: 'gone', description: 'When gone.', href: 'nope.md' }
    ], new Set(), 'en', base, fetchBody)
    const tool = skillTool(skills)!
    assert.equal(tool.name, 'read_skill')
    assert.deepEqual(tool.inputSchema.properties.name.oneOf, [{ const: 'a', description: 'When a.' }, { const: 'gone', description: 'When gone.' }])
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
    assert.deepEqual(await tool.execute({ name: 'a' }), { text: '# A\n\nDo this.' })
    const failed = await tool.execute({ name: 'gone' })
    assert.equal(failed.isError, true)
    assert.match(failed.text, /HTTP 404 \(https:\/\/api\.test\/v1\/nope\.md\)/)
    const unknown = await tool.execute({ name: 'nope' })
    assert.equal(unknown.isError, true)
    assert.match(unknown.text, /Available: a, gone/)
  })
})

describe('renderSkillFile', () => {
  it('renders SKILL.md with quoted frontmatter, and a digest over its bytes', () => {
    const file = renderSkillFile({ id: 'data-fair/workflow', name: 'workflow', description: 'Say "hi": now', body: 'Body.', digest: digestOf('Body.') })
    assert.equal(file.uri, 'skill://data-fair/workflow/SKILL.md')
    assert.equal(file.text, '---\nname: workflow\ndescription: "Say \\"hi\\": now"\n---\n\nBody.\n')
    assert.deepEqual(file.frontmatter, { name: 'workflow', description: 'Say "hi": now' })
    assert.equal(file.size, Buffer.byteLength(file.text))
    assert.equal(file.digest, 'sha256:' + createHash('sha256').update(file.text).digest('hex'))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test test/skills.test.ts`
Expected: FAIL — `resolveSkills`, `skillEntries`, `skillTool`, `digestOf`, `defaultSkillFetcher` are not exported.

- [ ] **Step 3: Update the types**

`src/types.ts`, replace `interface Skill` with:

```ts
/** A resolved skill, ready to be served as a `skill://` resource, listed in instructions and read by `read_skill`. */
export interface Skill {
  /** `<skill-name>` for a single document, `<service-id>/<skill-name>` once composed */
  id: string
  name: string
  /** what the skill is for and when to use it — the SKILL.md frontmatter description */
  description: string
  /** the markdown body, plus a `Tools:` line when the skill lists tools; empty when `error` is set */
  body: string
  /** `sha256:` over `body` */
  digest: string
  /** why a linked body could not be read; the skill stays listed and `read_skill` reports it */
  error?: string
  tools?: string[]
  profiles?: string[]
}

/** Reads a linked skill body; never throws. */
export type SkillBodyFetcher = (url: string) => Promise<{ text: string } | { error: string }>
```

In `interface ToolSet`, add after `instructions`:

```ts
  /** the document's own sections (tag guides), without skill entries — what a composer nests under the service heading */
  guide?: string
```

- [ ] **Step 4: Implement `src/skills.ts`**

Replace `buildSkills` (the whole function and its doc comment) with:

```ts
/** `sha256:` + 64 lowercase hex over the UTF-8 bytes of `text`. */
export const digestOf = (text: string): string => `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`

const withTools = (text: string, tools?: string[]) => tools?.length ? `${text}\n\nTools: ${tools.join(', ')}` : text

/** A served SKILL.md carries its own frontmatter, rebuilt from the entry; the file's is dropped. */
const stripFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '')

function resolveHref (href: string, base: string | undefined): string | undefined {
  try {
    return new URL(href).href
  } catch {
    return base ? new URL(href, base).href : undefined
  }
}

/** Fetches a linked body with the load-time fetch, reporting failures instead of throwing. */
export function defaultSkillFetcher (fetchFn: typeof fetch): SkillBodyFetcher {
  return async (url) => {
    try {
      const res = await fetchFn(url, { headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' } })
      if (!res.ok) return { error: `HTTP ${res.status}` }
      return { text: await res.text() }
    } catch (err: any) {
      return { error: `fetch failed: ${err?.message ?? err}` }
    }
  }
}

/**
 * The skills a profile set selects, from a document's or an index's `skills`, with their bodies:
 * inline, linked (resolved against `base`), or the description itself. A body that cannot be read
 * leaves the skill listed with an `error`, so a broken link never takes a service down.
 */
export async function resolveSkills (skills: AgentSkill[] | undefined, selected: Set<string>, locale: string, base: string | undefined, fetchBody: SkillBodyFetcher): Promise<Skill[]> {
  const out: Skill[] = []
  for (const skill of skills ?? []) {
    if (skill.profiles && !skill.profiles.some(p => selected.has(p))) continue
    const description = (localize(skill.description, locale) ?? '').trim()
    let text: string | undefined
    let error: string | undefined
    const href = localize(skill.href, locale)
    if (href) {
      const url = resolveHref(href, base)
      if (!url) {
        error = `relative link ${href} has no base URL to resolve against`
      } else {
        const res = await fetchBody(url)
        if ('error' in res) error = `${res.error} (${url})`
        else text = stripFrontmatter(res.text).trim()
      }
    } else {
      text = (localize(skill.body, locale) ?? description).trim()
    }
    const body = text === undefined ? '' : withTools(text, skill.tools)
    out.push({ id: skill.name, name: skill.name, description, body, digest: digestOf(body), tools: skill.tools, profiles: skill.profiles, ...(error ? { error } : {}) })
  }
  return out
}

/** Level 1 of the Agent Skills disclosure: what each skill is for, and how to read it. Never a body. */
export function skillEntries (skills: Skill[]): string {
  return skills.map(s => {
    const tools = s.tools?.length ? `Tools: ${s.tools.join(', ')}\n` : ''
    return `## ${s.name}\n\n${s.description}\n\n${tools}Read it with ${SKILL_TOOL}("${s.id}").`
  }).join('\n\n')
}

export const SKILL_TOOL = 'read_skill'

/**
 * Level 2: one tool returning a skill's body. Every host supports tools, where few read resources;
 * the `oneOf` carries each description, for hosts that never show server instructions.
 */
export function skillTool (skills: Skill[]): Tool | undefined {
  if (!skills.length) return undefined
  return {
    name: SKILL_TOOL,
    description: 'Read the full instructions of a skill. Each skill says when it applies: read it before starting such a task.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { oneOf: skills.map(s => ({ const: s.id, description: s.description })) } }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute (params) {
      const skill = skills.find(s => s.id === params?.name)
      if (!skill) return { isError: true, text: `Unknown skill: ${String(params?.name)}. Available: ${skills.map(s => s.id).join(', ')}` }
      if (skill.error) return { isError: true, text: `The skill ${skill.id} could not be read: ${skill.error}` }
      return { text: skill.body }
    }
  }
}
```

Update the import lines at the top of `src/skills.ts` to:

```ts
import { createHash } from 'node:crypto'
import { localize } from './localize.ts'
import type { AgentSkill, ResolvedOperation, Skill, SkillBodyFetcher, Tool } from './types.ts'
```

In `editorSkill`, replace its `return` line with:

```ts
  const text = body.trim()
  return { id: name, name, description, body: text, digest: digestOf(text), tools, ...(profiles ? { profiles } : {}) }
```

In `src/index.ts`, replace the line exporting from `./skills.ts` with:

```ts
export { resolveSkills, defaultSkillFetcher, digestOf, skillEntries, skillTool, SKILL_TOOL, renderSkillFile, type SkillFile } from './skills.ts'
```

(`src/load.ts` and `src/compose.ts` still import `buildSkills`; Tasks 3 and 4 replace those calls. Until then `check-types` fails on them — expected inside this task.)

- [ ] **Step 5: Run the tests**

Run: `NODE_ENV=test node --test test/skills.test.ts`
Expected: PASS (all describes).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/skills.ts src/index.ts test/skills.test.ts
git commit -m "feat(skills): resolve inline or linked bodies, render entries, build read_skill"
```

---

### Task 3: Skills in `load()`

**Files:**
- Modify: `src/load.ts` (`LoadOptions`, `buildInstructions`, the end of `load`), `src/snapshot.ts`
- Test: `test/load.test.ts`, `test/snapshot.test.ts`, and the expectation updates listed in Step 4

**Interfaces:**
- Consumes: `resolveSkills`, `defaultSkillFetcher`, `skillEntries`, `skillTool`, `SKILL_TOOL`, `editorSkill` (Task 2).
- Produces: `LoadOptions.documentUrl?: string`, `LoadOptions.skillBodies?: SkillBodyFetcher`, `LoadOptions.skillTool?: boolean` (default `true`); `ToolSet.guide`; `buildInstructions(doc, profiles, ops, locale)` now returns only tag sections; snapshot skills `{ id, name, description, digest }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/load.test.ts`:

```ts
describe('load — linked skills', () => {
  const skilled = (skills: unknown[], servers = [{ url: 'https://api.test/v1' }]) => ({
    ...structuredClone(petstore),
    servers,
    'x-agent': { ...petstore['x-agent'], skills }
  })
  const bodies = (files: Record<string, string>) => stub(req => req.url in files
    ? new Response(files[req.url], { headers: { 'content-type': 'text/markdown' } })
    : json({ total: 0, results: [] }))

  it('resolves a relative link under servers[0].url for a document passed as an object', async () => {
    const s = bodies({ 'https://api.test/v1/agents/skills/w.md': '---\nname: w\n---\nThe body.' })
    const ts = await load(skilled([{ name: 'w', description: 'When w.', href: 'agents/skills/w.md' }]), { fetch: s.fetchFn })
    assert.deepEqual(ts.skills.map(x => [x.id, x.body, x.error]), [['w', 'The body.', undefined]])
  })

  it('resolves against the document URL when loaded from a URL, or the documentUrl option', async () => {
    const doc = skilled([{ name: 'w', description: 'When w.', href: 'skills/w.md' }], [{ url: 'https://elsewhere.test/api' }])
    const s = stub(req => req.url === 'https://docs.test/v2/openapi.json' ? json(doc) : req.url === 'https://docs.test/v2/skills/w.md' ? new Response('From the doc URL.') : new Response('no', { status: 404 }))
    assert.equal((await load('https://docs.test/v2/openapi.json', { fetch: s.fetchFn })).skills[0].body, 'From the doc URL.')
    assert.equal((await load(doc, { fetch: s.fetchFn, documentUrl: 'https://docs.test/v2/openapi.json' })).skills[0].body, 'From the doc URL.')
  })

  it('lists skills in the instructions without bodies, and appends read_skill', async () => {
    const s = bodies({ 'https://api.test/v1/w.md': 'SECRET BODY' })
    const ts = await load(skilled([{ name: 'w', description: 'When w.', href: 'w.md', tools: ['pets_list_pets'] }]), { fetch: s.fetchFn })
    assert.equal(ts.instructions, '## w\n\nWhen w.\n\nTools: pets_list_pets\nRead it with read_skill("w").\n\n## Pets\n\nPets have an id and a name.')
    assert.equal(ts.guide, '## Pets\n\nPets have an id and a name.')
    assert.deepEqual(ts.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet', 'read_skill'])
    assert.deepEqual(await ts.tools[2].execute({ name: 'w' }), { text: 'SECRET BODY\n\nTools: pets_list_pets' })
  })

  it('keeps serving when a body is unreachable', async () => {
    const ts = await load(skilled([{ name: 'w', description: 'When w.', href: 'gone.md' }]), { fetch: bodies({}).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet', 'read_skill'])
    assert.match(ts.skills[0].error!, /HTTP 404 \(https:\/\/api\.test\/v1\/gone\.md\)/)
  })

  it('leaves read_skill out on request, and refuses an operation tool taking its name', async () => {
    const plain = await load(skilled([{ name: 'w', description: 'When w.' }]), { fetch: bodies({}).fetchFn, skillTool: false })
    assert.ok(!plain.tools.some(t => t.name === 'read_skill'))
    const clashing = skilled([{ name: 'w', description: 'When w.' }])
    clashing.paths['/pets'].get['x-agent'].name = 'read_skill'
    clashing['x-agent'].namePrefix = ''
    await assert.rejects(load(clashing, { fetch: bodies({}).fetchFn }), /read_skill is reserved/)
  })
})
```

In `test/snapshot.test.ts`, replace the line asserting `a.skills` with:

```ts
    assert.deepEqual(a.skills, [{ id: 'workflow', name: 'workflow', description: 'Start with list_pets, then get_pet.', digest: digestOf('Start with list_pets, then get_pet.') }])
```

and add `import { digestOf } from '../src/skills.ts'` to its imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test --test-name-pattern="linked skills|stable, JSON" test/load.test.ts test/snapshot.test.ts`
Expected: FAIL — links are not resolved, the instructions hold full texts, there is no `read_skill`, the snapshot has no `digest`.

- [ ] **Step 3: Implement**

In `src/load.ts`:

1. Imports: replace `import { buildSkills, editorSkill } from './skills.ts'` with

```ts
import { resolveSkills, defaultSkillFetcher, editorSkill, skillEntries, skillTool, SKILL_TOOL } from './skills.ts'
```

and add `SkillBodyFetcher` to the type import from `./types.ts`.

2. In `interface LoadOptions`, add after `baseUrl?: string`:

```ts
  /** the URL the document was fetched from, for relative skill links; set automatically when `spec` is a URL */
  documentUrl?: string
  /** how linked skill bodies are read; the composer passes its cache, the default fetches with `fetch` */
  skillBodies?: SkillBodyFetcher
  /** add the `read_skill` tool when skills are selected (default true); a composer adds one for the merged set */
  skillTool?: boolean
```

3. In `buildInstructions`, delete the `for (const skill of root.skills ?? []) { … }` loop and the now unused `root` and `selected` constants (keep the tag loop). Update its doc comment, or add one: `/** The document's own guide: the skill text of the tags its selected operations carry. Skills are listed separately, by skillEntries. */`

4. Replace the end of `load`, from `const editorSections: string[] = []` to the `return`, with:

```ts
  const editorSkills: Skill[] = []
  for (const op of editorOps) {
    const group = await buildEditorTools(op, { doc, baseUrl, fetch: contextualFetch(fetchFn), locale: o.locale })
    tools.push(...group.tools)
    editorSkills.push(editorSkill(op, group.skill, group.tools.map(t => t.name), o.locale))
  }
  // Relative skill links resolve against the document's URL, else its server URL taken as a
  // directory: `…/api/v1` + `agents/skills/x.md` is `…/api/v1/agents/skills/x.md`.
  const skillBase = options.documentUrl ?? (typeof spec === 'string' ? spec : undefined) ?? baseUrl.replace(/\/?$/, '/')
  const selected = selectProfiles(profiles, expandProfiles(root.profiles))
  const skills = [...await resolveSkills(root.skills, selected, o.locale, skillBase, options.skillBodies ?? defaultSkillFetcher(fetchFn)), ...editorSkills]
  if (skills.length && options.skillTool !== false) {
    if (tools.some(t => t.name === SKILL_TOOL)) throw new Error(`tool name ${SKILL_TOOL} is reserved for skills`)
    tools.push(skillTool(skills)!)
  }
  const guide = buildInstructions(doc, profiles, ops, o.locale)
  const instructions = [skillEntries(skills), guide].filter(Boolean).join('\n\n')
  return { profiles, instructions, guide, tools, skills }
```

In `src/snapshot.ts`: change the `skills` type to `{ id: string, name: string, description: string, digest: string }[]` and the mapping to `toolSet.skills.map(s => ({ id: s.id, name: s.name, description: s.description, digest: s.digest }))`.

- [ ] **Step 4: Update the expectations `read_skill` changes**

Every set built from `test/fixtures/petstore.json` selects its `workflow` skill (no `profiles`), and editor groups and the data-fair fixture carry skills, so those sets now end with `read_skill`. Update exactly these assertions, then run each file and check that each remaining diff is only that extra name:

- `test/load.test.ts:25` → `['pets_list_pets', 'pets_get_pet', 'read_skill']`
- `test/load.test.ts:36` → `['pets_create_pet', 'read_skill']`
- `test/load.test.ts:44` → `['pets_list_pets', 'pets_create_pet', 'pets_get_pet', 'read_skill']`
- `test/load.test.ts:58` → `['list_pets', 'get_pet', 'read_skill']`
- `test/load.test.ts:26` → `'## workflow\n\nStart with list_pets, then get_pet.\n\nRead it with read_skill("workflow").\n\n## Pets\n\nPets have an id and a name.'`
- `test/load.test.ts:37` → `'## workflow\n\nCommencez par list_pets.\n\nRead it with read_skill("workflow").\n\n## editing\n\nUse create_pet only when asked.\n\nRead it with read_skill("editing").\n\n## Pets\n\nPets have an id and a name.'`
- `test/data-fair.test.ts:25` → the same sorted list with `'read_skill'` inserted between `'list_datasets'` and `'search_data'`
- `test/editor-group.test.ts:48` → add `'read_skill'` to the sorted list at its alphabetical place
- `test/evals/arms.test.ts:51` and `:68` → add `'read_skill'` between `'list_datasets'` and `'search_data'`; `:53` and `:69` → `7`
- `test/adapters-mcp.test.ts:40` → `['pets_list_pets', 'pets_get_pet', 'read_skill']`

Unchanged on purpose: `test/load.test.ts:120` and `:126` (the views fixture has no skills), and the `vocabulary-lint` counts (their documents have no skills). If any other assertion fails, read its diff: if it is only `read_skill` appended to a set that has skills, update it the same way and add a ledger note; otherwise it is a defect to debug.

- [ ] **Step 5: Run the tests**

Run: `NODE_ENV=test node --test --test-force-exit test/*.test.ts test/evals/*.test.ts`
Expected: PASS except `compose.test.ts`, `bin.test.ts`, the composer tests of `adapters-mcp.test.ts` and the "arm C" test of `test/evals/arms.test.ts` (it composes an index), which Task 4 makes pass (the composer still calls `buildSkills`), and the known "arm A" failure.

- [ ] **Step 6: Commit**

```bash
git add src/load.ts src/snapshot.ts test/load.test.ts test/snapshot.test.ts test/data-fair.test.ts test/editor-group.test.ts test/evals/arms.test.ts test/adapters-mcp.test.ts
git commit -m "feat(load): linked skills, instructions without bodies, read_skill"
```

---

### Task 4: Skills in the composer

**Files:**
- Modify: `src/compose.ts` (`fetchConditional`, `createComposer`: cache, `loadDoc`, `build`, `refresh`, `services`)
- Test: `test/compose.test.ts`, `test/bin.test.ts`, `test/adapters-mcp.test.ts`

**Interfaces:**
- Consumes: `resolveSkills`, `skillEntries`, `skillTool`, `SKILL_TOOL` (Task 2); `LoadOptions.documentUrl/skillBodies/skillTool`, `ToolSet.guide` (Task 3).
- Produces: composition tool sets ending with one `read_skill`; `ServiceStatus.warnings` entries `skill <name>: <error>` on both composer-level and composition statuses.

- [ ] **Step 1: Let the test stack serve text**

In `test/compose.test.ts`, in `stack()`, change the map's value type to `{ body: unknown, etag: string, text?: boolean }`, add after `const set = …`:

```ts
  const setText = (url: string, body: string) => docs.set(url, { body, etag: `"${++counter}"`, text: true })
```

replace the success response line with:

```ts
    return doc.text
      ? new Response(doc.body as string, { headers: { 'content-type': 'text/markdown', etag: doc.etag } })
      : new Response(JSON.stringify(doc.body), { headers: { 'content-type': 'application/json', etag: doc.etag } })
```

and return `{ set, setText, fetchFn, hits }`.

- [ ] **Step 2: Write the failing tests**

Append inside `describe('createComposer', …)`:

```ts
  it('adds one read_skill for the merged set, listing index and service skills with their ids', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const full = await composer.compose(['full'])
    const tools = full.toolSet.tools.filter(t => t.name === 'read_skill')
    assert.equal(tools.length, 1)
    assert.deepEqual(tools[0].inputSchema.properties.name.oneOf.map((o: any) => o.const), ['cross-booking', 'pets/workflow', 'pets/editing', 'vets/booking'])
    assert.match(full.toolSet.instructions, /^## cross-booking\n\nFind a pet, then book a vet\.\n\nRead it with read_skill\("cross-booking"\)\.\n\n# Pets\n\n## workflow\n\n[^\n]+\n\nRead it with read_skill\("pets\/workflow"\)\./)
  })

  it('reads linked skill bodies once, revalidates them on refresh, and notifies a change', async () => {
    const s = base()
    s.set(PETS, { ...petstore, 'x-agent': { ...petstore['x-agent'], skills: [{ name: 'workflow', description: 'When pets.', href: 'skills/workflow.md' }] } })
    s.setText('https://pets.test/skills/workflow.md', 'Version 1.')
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'])
    const read = () => c.toolSet.tools.find(t => t.name === 'read_skill')!.execute({ name: 'pets/workflow' })
    assert.deepEqual(await read(), { text: 'Version 1.' })
    await composer.compose(['full'])
    assert.equal(s.hits['https://pets.test/skills/workflow.md'], 1, 'one fetch for every composition')
    let notified = 0
    c.onChange(() => notified++)
    assert.equal(await composer.refresh(), false, 'an unchanged body is a 304')
    s.setText('https://pets.test/skills/workflow.md', 'Version 2.')
    assert.equal(await composer.refresh(), true)
    assert.equal(notified, 1)
    assert.deepEqual(await read(), { text: 'Version 2.' })
  })

  it('reports an unreachable body as a warning, at the composer and composition levels', async () => {
    const s = base()
    s.set(PETS, { ...petstore, 'x-agent': { ...petstore['x-agent'], skills: [{ name: 'workflow', description: 'When pets.', href: 'skills/gone.md' }] } })
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const warning = 'skill workflow: HTTP 404 (https://pets.test/skills/gone.md)'
    assert.ok(composer.services[0].warnings?.includes(warning), JSON.stringify(composer.services[0]))
    const c = await composer.compose(['explore'])
    assert.equal(c.services[0].status, 'ok')
    assert.ok(c.services[0].warnings?.includes(warning))
  })

  it('excludes a service whose operation tool is named read_skill', async () => {
    const s = base()
    s.set(VETS, { ...vetstore, 'x-agent': { ...vetstore['x-agent'], namePrefix: '' }, paths: { '/vets': { get: { ...vetstore.paths['/vets'].get, 'x-agent': { profiles: ['explore'], name: 'read_skill' } } } } })
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'])
    assert.equal(c.services[1].status, 'error')
    assert.match(c.services[1].reason!, /read_skill is reserved/)
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test --test-force-exit test/compose.test.ts`
Expected: FAIL — the composer imports the removed `buildSkills` (module error) until Step 4.

- [ ] **Step 4: Implement**

In `src/compose.ts`:

1. Imports: replace `import { buildSkills } from './skills.ts'` with `import { resolveSkills, skillEntries, skillTool, SKILL_TOOL } from './skills.ts'`, and add `SkillBodyFetcher` and `AgentSkill` to the type import from `./types.ts`.

2. Generalize `fetchConditional` with a body reader, keeping JSON as default:

```ts
async function fetchConditional<T> (entry: Cached<T>, fetchFn: typeof fetch, parse: (body: unknown) => T, read: (res: Response) => Promise<unknown> = res => res.json()): Promise<boolean> {
```

and inside it replace `entry.value = parse(await res.json())` with `entry.value = parse(await read(res))`.

3. In `createComposer`, after `const docs = new Map<string, CachedDoc>()`, add:

```ts
  // Linked skill bodies, shared by every composition: fetched once, revalidated on refresh.
  const skillCache = new Map<string, Cached<string>>()
  const readText = (res: Response) => res.text()
  const skillBodies: SkillBodyFetcher = async (url) => {
    let entry = skillCache.get(url)
    if (!entry) {
      entry = { url }
      skillCache.set(url, entry)
      await fetchConditional(entry, fetchFn, body => body as string, readText)
    }
    return entry.value !== undefined ? { text: entry.value } : { error: entry.error ?? 'not loaded' }
  }
  /** Every skill of a document (all profiles), resolved through the cache: what a service's status reports. */
  // every profile any of the skills names, so that every skill is resolved, whatever the request
  const skillWarnings = async (skills: AgentSkill[] | undefined, base: string | undefined): Promise<string[]> =>
    (await resolveSkills(skills, new Set((skills ?? []).flatMap(s => s.profiles ?? [])), locale, base, skillBodies))
      .filter(s => s.error).map(s => `skill ${s.name}: ${s.error}`)
```

4. In `loadDoc`, after the successful `entry.value = await loadSpec(entry.value, fetchFn)`, add:

```ts
        // fetched with the document, so a broken link shows in the service status at startup
        entry.skillWarnings = await skillWarnings(entry.value['x-agent']?.skills, entry.url)
```

and extend `interface CachedDoc` with `skillWarnings?: string[]`.

5. In `build`:
   - replace `skills.push(...buildSkills(current.skills, indexSelected, locale))` and the following `for (const s of skills) sections.push(…)` line with:

```ts
    skills.push(...await resolveSkills(current.skills, indexSelected, locale, indexEntry.url || undefined, skillBodies))
    if (skills.length) sections.push(skillEntries(skills))
```

   - in the `load(d.value, { … })` call, add `documentUrl: d.url, skillBodies, skillTool: false` to the options object;
   - right after the existing tool-name collision check, add:

```ts
      if (ts.tools.some(t => t.name === SKILL_TOOL)) { status.status = 'error'; status.reason = `tool name ${SKILL_TOOL} is reserved for skills`; continue }
```

   - replace `if (ts.instructions) sections.push(`# ${d.value.info?.title ?? d.id}\n\n${ts.instructions}`)` and the `skills.push(...ts.skills.map(…))` line with:

```ts
      const serviceSkills = ts.skills.map(s => ({ ...s, id: `${d.id}/${s.id}` }))
      skills.push(...serviceSkills)
      const serviceText = [skillEntries(serviceSkills), ts.guide].filter(Boolean).join('\n\n')
      if (serviceText) sections.push(`# ${d.value.info?.title ?? d.id}\n\n${serviceText}`)
      const failed = ts.skills.filter(s => s.error).map(s => `skill ${s.name}: ${s.error}`)
      if (failed.length) status.warnings = [...(status.warnings ?? []), ...failed]
```

   - before `return { toolSet: … }`, add `const readSkill = skillTool(skills); if (readSkill) tools.push(readSkill)`.

6. In `refresh`, after the documents are revalidated and before `if (!changed) return false`, add:

```ts
    for (const entry of skillCache.values()) {
      if (await fetchConditional(entry, fetchFn, body => body as string, readText)) changed = true
    }
```

7. In the `services` getter, after the vocabulary warnings are attached, add the document's skill warnings:

```ts
        const failed = d.skillWarnings ?? []
        if (failed.length) status.warnings = [...(status.warnings ?? []), ...failed]
```

- [ ] **Step 5: Update the composer expectations**

Sets that select at least one skill now end with `read_skill`. Update:

- `test/compose.test.ts:51` → `['pets_list_pets', 'pets_get_pet', 'vets_list_vets', 'read_skill']`
- `:71` → `['pets_list_pets', 'pets_create_pet', 'pets_get_pet', 'vets_list_vets', 'vets_create_appointment', 'read_skill']`
- `:93`, `:106`, `:144` → `['pets_list_pets', 'pets_get_pet', 'read_skill']`
- `:132` → `['pets_list_pets', 'pets_get_pet', 'vets_list_all_vets', 'read_skill']`
- `:164` → `['pets_create_pet', 'vets_create_appointment', 'read_skill']`
- `:189` → `['list_pets', 'get_pet', 'read_skill']`; `:193` → `['pets_list_pets', 'pets_get_pet', 'vets_list_vets', 'read_skill']`; `:196` → `['legacy_list_pets', 'legacy_get_pet', 'legacy_list_vets', 'read_skill']`
- `:73` → `assert.match(full.toolSet.instructions, /^## cross-booking\n\nFind a pet, then book a vet\.\n\nRead it with read_skill\("cross-booking"\)\.\n\n# Pets/)`
- `test/bin.test.ts:46` → `['pets_list_pets', 'pets_get_pet', 'read_skill']`; `:80` → `['pets_list_pets', 'pets_create_pet', 'pets_get_pet', 'vets_list_vets', 'vets_create_appointment', 'read_skill']`; `:98` → `['pets_create_pet', 'vets_create_appointment', 'read_skill']`
- `test/adapters-mcp.test.ts:113` → `['pets_list_pets', 'pets_get_pet', 'read_skill']`; `:128` → `['pets_create_pet', 'read_skill']`

`test/compose.test.ts:82` stays (`edit_appointments` selects no skill). As in Task 3: any other failure that is only `read_skill` appended to a set with skills is updated with a ledger note; anything else is a defect.

- [ ] **Step 6: Run the tests**

Run: `NODE_ENV=test node --test --test-force-exit test/*.test.ts test/evals/*.test.ts && npm run check-types && npm run lint`
Expected: PASS except the known "arm A".

- [ ] **Step 7: Commit**

```bash
git add src/compose.ts test/compose.test.ts test/bin.test.ts test/adapters-mcp.test.ts
git commit -m "feat(compose): cached linked skills, one read_skill per composition, skill warnings"
```

---

### Task 5: Serving — errored skills out of the manifest

**Files:**
- Modify: `src/adapters/mcp.ts` (`toMcpServer`)
- Test: `test/adapters-mcp.test.ts`

**Interfaces:**
- Consumes: `Skill.error` (Task 2).

- [ ] **Step 1: Write the failing test**

Append inside `describe('mcp adapter over a tool set (in-memory, 2025 era)', …)` (reuse the file's in-memory helper; if it only builds from the petstore fixture, build this server directly as below, adapting the helper's client/server wiring):

```ts
  it('leaves a skill whose body failed out of the resources and skills/list, keeping read_skill', async () => {
    const toolSet = await load({
      ...structuredClone(petstore),
      servers: [{ url: 'https://api.test/v1' }],
      'x-agent': { ...petstore['x-agent'], skills: [{ name: 'ok', description: 'Fine.' }, { name: 'gone', description: 'Broken.', href: 'gone.md' }] }
    }, { fetch: (async () => new Response('no', { status: 404 })) as unknown as typeof fetch })
    const { client } = await inMemory(toolSet)
    const { resources } = await client.listResources()
    assert.deepEqual(resources.map(r => r.uri), ['skill://ok/SKILL.md'])
    const listed = await client.request({ method: 'skills/list', params: {} }, SkillsList)
    assert.deepEqual(listed.skills.map((s: any) => s.frontmatter.name), ['ok'])
    const res: any = await client.callTool({ name: 'read_skill', arguments: { name: 'gone' } })
    assert.equal(res.isError, true)
  })
```

If `inMemory` takes no argument, change its signature to `inMemory (toolSet?: ToolSet)` and default to the tool set it builds today.

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_ENV=test node --test --test-force-exit --test-name-pattern="body failed" test/adapters-mcp.test.ts`
Expected: FAIL — `skill://gone/SKILL.md` is listed with an empty body.

- [ ] **Step 3: Implement**

In `src/adapters/mcp.ts`, `toMcpServer`, replace `const skills = toolSet.skills.map(renderSkillFile)` with:

```ts
  // A skill whose body could not be read has no digest to publish; read_skill reports its error.
  const skills = toolSet.skills.filter(s => !s.error).map(renderSkillFile)
```

- [ ] **Step 4: Run the tests**

Run: `NODE_ENV=test node --test --test-force-exit test/*.test.ts test/evals/*.test.ts`
Expected: PASS except the known "arm A".

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mcp.ts test/adapters-mcp.test.ts
git commit -m "feat(mcp): publish only the skills whose body was read"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/x-agent.md` (section "Root", the `skills` bullet), `README.md` (section "Skills", section "Composing a deployment"), `skills/openapi-mcp/SKILL.md` (the root row of "The annotation at a glance")

- [ ] **Step 1: `docs/x-agent.md`**

In the "Root" YAML example, replace the `skills:` entry with:

```yaml
  skills:
    - name: workflow
      description: How to explore datasets. Use it before searching or aggregating data.
      href: agents/skills/workflow.md
      profiles: [explore]
      tools: [describe_dataset, search_data]
```

and replace the `skills` bullet below it with:

```markdown
- **`skills`** — skills in the Agent Skills sense. `description` (localized, at most 1024
  characters) says what the skill is for and when to use it: it is always shown, in the MCP
  `instructions` and in the `read_skill` tool. The body is read on demand: inline in `body`, or in
  a markdown file linked by `href` (localized; relative to the URL the document was fetched from,
  or to `servers[0].url` for a document passed as an object). `href` and `body` are exclusive;
  with neither, the description is the body. A linked file's frontmatter is ignored. `profiles`
  filters, `tools` adds a `Tools: …` line. The name follows the Agent Skills format
  (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters) and becomes the last segment of
  `skill://…/<name>/SKILL.md`.
```

- [ ] **Step 2: `README.md`**

Replace the "## Skills" section body with:

```markdown
Skills follow the Agent Skills disclosure levels. The MCP `instructions` list each selected skill
by name and description, with a pointer; bodies never go there. A generated `read_skill` tool —
one per tool set or composition, its input listing every skill id with its description — returns a
body on demand, which works in every host. Hosts with the skills extension
(`io.modelcontextprotocol/skills`) also get `skills/list`, `skills/get` and `resources/read` of
`skill://<service-id>/<name>/SKILL.md`, with a SHA-256 manifest.

A body is inline (`body`) or linked (`href`, a markdown file next to the document). `load()` reads
linked bodies with its `fetch`; a composer caches them with conditional requests and revalidates
them on `refresh()`. A body that cannot be read keeps the skill listed: `read_skill` reports the
error, the service status carries a warning, and the manifest leaves it out.

### Upgrading to 0.4.0

A skill's `description` is now at most 1024 characters and is never split into paragraphs. Move a
long text to `body` (or to a file served next to the document, referenced by `href`) and write a
one- or two-sentence `description`. Tool sets with skills gain the `read_skill` tool, and golden
snapshots gain each skill's `digest`.
```

In "Composing a deployment", after the paragraph about vocabulary warnings, add:

```markdown
A skill body that cannot be read is reported the same way: `warnings: ['skill <name>: HTTP 404 (<url>)']`.
```

- [ ] **Step 3: `skills/openapi-mcp/SKILL.md`**

In "The annotation at a glance", change the Document root row's second cell to:

```markdown
| Document root | `namePrefix`, `profiles`, `skills` (`name`, short `description`, body in `body` or linked by `href`) |
```

- [ ] **Step 4: Run the full gate**

Run: `npm run lint && npm run check-types && NODE_ENV=test node --test --test-force-exit test/*.test.ts test/evals/*.test.ts`
Expected: PASS except the known "arm A".

- [ ] **Step 5: Commit**

```bash
git add docs/x-agent.md README.md skills/openapi-mcp/SKILL.md
git commit -m "docs: linked skills, read_skill and the 0.4.0 upgrade"
```
