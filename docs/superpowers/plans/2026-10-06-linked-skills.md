# Linked Skills and Progressive Disclosure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a skill's body live in a linked markdown file, keep only names and descriptions in the MCP instructions, and serve bodies through the existing `skill://` resources and skills extension.

**Architecture:** `src/skills.ts` becomes the one place that resolves skill entries (inline or linked body, frontmatter stripped, digest) and renders their instructions entries. `load()` resolves the document's skills against the document URL; the composer resolves through a conditional-request cache shared by every composition and revalidated on `refresh()`. Validation enforces the Agent Skills split: a short `description`, the body in `body` or `href`. No tool is generated.

**Tech Stack:** TypeScript on Node 24 (type stripping), `node:test`, Ajv 2020, MCP SDK v2 adapter.

**Spec:** `docs/superpowers/specs/2026-10-06-linked-skills-design.md`

## Global Constraints

- `description`: "At most 1024 characters per locale — the Agent Skills limit — refused at validation otherwise."
- "`href` and `body` are mutually exclusive (refused at validation). A skill with neither has its description as its body."
- "No text is derived from paragraphs any more: the first-paragraph heuristic is removed."
- "A relative `href` resolves against the URL the document (or index) was fetched from. For a document passed as an object, it resolves against `servers[0].url` (or the `baseUrl` option)." — the server URL is treated as a directory (a trailing `/` is added), so `…/api/v1` + `agents/skills/x.md` gives `…/api/v1/agents/skills/x.md`.
- "A body file may start with a YAML frontmatter block; it is stripped."
- "A body that cannot be fetched … does not fail the service": the skill stays in the instructions and in `resources/list`, its `resources/read` answers an MCP error naming the URL and status, it is absent from `skills/list` and `skills/get`, the composer adds `skill <name>: <reason>` to the service `warnings`.
- "No body is ever rendered into the instructions." Entries point to the resource: `Read it as the MCP resource skill://<id>/SKILL.md.`
- No `read_skill` tool: level 2 goes through resources and the skills extension.
- Snapshot skill entries gain `digest` (`sha256:` over the body).
- Tag-level `x-agent.skill` texts are unchanged.
- Work on branch `feat/linked-skills` (from `feat/editor-skill`). Tests: `NODE_ENV=test node --test --test-force-exit test/*.test.ts test/evals/*.test.ts`; `test/evals/arms.test.ts` "arm A" fails before this work (it launches the `~/data-fair/mcp` checkout) and is not a regression. Gate: `npm run lint && npm run check-types` plus the tests.

## Review Focus

1. A linked body changes upstream while a composer runs → after `refresh()` the digest changes and listeners are notified; an unchanged body (304) notifies nothing. (Task 4)
2. A relative `href` in a document passed as an object with `servers[0].url` ending in a path segment (`…/api/v1`) → resolved under that segment, not beside it. (Task 3)
3. A skill body unreachable (404) → the service still serves its tools; the skill's resource read answers an error naming the URL; it is absent from `skills/list`; the composer-level status carries the warning. (Tasks 3, 4, 5)
4. A document loaded from a URL whose servers point elsewhere → its relative skill links resolve against the document URL. (Task 3)
5. A composition with skills from several services and the index → each instructions entry points to the composed resource URI (`skill://pets/workflow/SKILL.md`), the one `resources/read` serves. (Task 4)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types.ts` | vocabulary and result types | `AgentSkill.href/body`, `Skill.digest/error`, `ToolSet.guide`, `SkillBodyFetcher` |
| `src/vocabulary/schema.ts`, `src/index-contract.ts` | validation | short `description`, `href`, `body`, exclusivity |
| `src/skills.ts` | resolve and render | `resolveSkills`, `defaultSkillFetcher`, `digestOf`, `skillEntries` |
| `src/load.ts` | single document | skill resolution, instructions, `guide` |
| `src/compose.ts` | deployment | skill body cache, refresh, warnings |
| `src/snapshot.ts` | golden view | `digest` |
| `src/adapters/mcp.ts` | MCP serving | errored skills: listed resource, read error, out of the manifest |
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

Append to `test/index-contract.test.ts` (add `import { validateIndex } from '../src/index-contract.ts'` if it is not imported):

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
Expected: FAIL — `href`/`body` are unknown properties, the long description and the pair are accepted.

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

`src/index-contract.ts`: add the same `shortLocalized` constant after its `localized` constant, and replace its skill item schema with the same object, without the two comment lines about the extension.

`test/fixtures/data-fair-annotations.ts`: in the `workflow` skill, rename the key `description:` (the long template string) to `body:`, and add before it:

```ts
    description: 'How to query French open data through Data Fair: find datasets, read their schema, then search, aggregate or compute metrics.',
```

- [ ] **Step 4: Run the tests**

Run: `NODE_ENV=test node --test --test-force-exit test/*.test.ts`
Expected: PASS (resolution is unchanged until Task 2; the fixture now validates).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/vocabulary/schema.ts src/index-contract.ts test/fixtures/data-fair-annotations.ts test/vocabulary.test.ts test/index-contract.test.ts
git commit -m "feat(vocabulary)!: skills take a short description and an inline or linked body"
```

---

### Task 2: Resolving skills and rendering their entries

**Files:**
- Modify: `src/types.ts` (`Skill`, `ToolSet`, new `SkillBodyFetcher`), `src/skills.ts`, `src/index.ts`
- Rewrite: `test/skills.test.ts`

**Interfaces:**
- Consumes: `AgentSkill` (Task 1).
- Produces (exported from `src/skills.ts` and the package root):
  - `type SkillBodyFetcher = (url: string) => Promise<{ text: string } | { error: string }>` (in `types.ts`)
  - `Skill = { id, name, description, body, digest: string, error?: string, tools?, profiles? }`
  - `resolveSkills(skills: AgentSkill[] | undefined, selected: Set<string>, locale: string, base: string | undefined, fetchBody: SkillBodyFetcher): Promise<Skill[]>`
  - `defaultSkillFetcher(fetchFn: typeof fetch): SkillBodyFetcher`
  - `digestOf(text: string): string`
  - `skillUri(skill: Skill): string` → `skill://<id>/SKILL.md`
  - `skillEntries(skills: Skill[]): string`
  - `editorSkill(...)` now also sets `digest`; `renderSkillFile` uses `skillUri`
  - `ToolSet.guide?: string` — the document's own sections (tag guides) without skill entries.

- [ ] **Step 1: Rewrite the tests**

Replace the content of `test/skills.test.ts` with:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveSkills, renderSkillFile, skillEntries, skillUri, digestOf, defaultSkillFetcher } from '../src/skills.ts'
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
  it('renders name, description, tools and the resource to read, never the body', async () => {
    const skills = await resolveSkills([{ name: 'w', description: 'When w.', body: 'SECRET BODY', tools: ['t1'] }], new Set(), 'en', base, fetchBody)
    const composed = skills.map(s => ({ ...s, id: 'svc/w' }))
    assert.equal(skillUri(composed[0]), 'skill://svc/w/SKILL.md')
    const text = skillEntries(composed)
    assert.equal(text, '## w\n\nWhen w.\n\nTools: t1\nRead it as the MCP resource skill://svc/w/SKILL.md.')
    assert.doesNotMatch(text, /SECRET/)
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
Expected: FAIL — `resolveSkills`, `skillEntries`, `skillUri`, `digestOf`, `defaultSkillFetcher` are not exported.

- [ ] **Step 3: Update the types**

`src/types.ts`, replace `interface Skill` with:

```ts
/** A resolved skill, ready to be served as a `skill://` resource and listed in instructions. */
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
  /** why a linked body could not be read; the skill stays listed and its resource read reports it */
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

Replace the import lines with:

```ts
import { createHash } from 'node:crypto'
import { localize } from './localize.ts'
import type { AgentSkill, ResolvedOperation, Skill, SkillBodyFetcher } from './types.ts'
```

Replace `buildSkills` (the function and its doc comment) with:

```ts
/** `sha256:` + 64 lowercase hex over the UTF-8 bytes of `text`. */
export const digestOf = (text: string): string => `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`

/** The resource a skill is served at: what instructions entries point to. */
export const skillUri = (skill: Pick<Skill, 'id'>): string => `skill://${skill.id}/SKILL.md`

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

/** Level 1 of the Agent Skills disclosure: what each skill is for, and the resource to read. Never a body. */
export function skillEntries (skills: Skill[]): string {
  return skills.map(s => {
    const tools = s.tools?.length ? `Tools: ${s.tools.join(', ')}\n` : ''
    return `## ${s.name}\n\n${s.description}\n\n${tools}Read it as the MCP resource ${skillUri(s)}.`
  }).join('\n\n')
}
```

In `editorSkill`, replace its `return` line with:

```ts
  const text = body.trim()
  return { id: name, name, description, body: text, digest: digestOf(text), tools, ...(profiles ? { profiles } : {}) }
```

In `renderSkillFile`, replace `uri: \`skill://${skill.id}/SKILL.md\`,` with `uri: skillUri(skill),`.

In `src/index.ts`, replace the line exporting from `./skills.ts` with:

```ts
export { resolveSkills, defaultSkillFetcher, digestOf, skillUri, skillEntries, renderSkillFile, type SkillFile } from './skills.ts'
```

(`src/load.ts` and `src/compose.ts` still import `buildSkills` until Tasks 3 and 4; `check-types` fails on them inside this task — expected.)

- [ ] **Step 5: Run the tests**

Run: `NODE_ENV=test node --test test/skills.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/skills.ts src/index.ts test/skills.test.ts
git commit -m "feat(skills): resolve inline or linked bodies and render short entries"
```

---

### Task 3: Skills in `load()`

**Files:**
- Modify: `src/load.ts` (`LoadOptions`, `buildInstructions`, the end of `load`), `src/snapshot.ts`
- Test: `test/load.test.ts`, `test/snapshot.test.ts`

**Interfaces:**
- Consumes: `resolveSkills`, `defaultSkillFetcher`, `skillEntries`, `editorSkill` (Task 2).
- Produces: `LoadOptions.documentUrl?: string`, `LoadOptions.skillBodies?: SkillBodyFetcher`; `ToolSet.guide`; `buildInstructions(doc, profiles, ops, locale)` now returns only tag sections; snapshot skills `{ id, name, description, digest }`.

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
    : new Response('no', { status: 404 }))

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

  it('lists skills in the instructions without bodies, pointing to their resources', async () => {
    const s = bodies({ 'https://api.test/v1/w.md': 'SECRET BODY' })
    const ts = await load(skilled([{ name: 'w', description: 'When w.', href: 'w.md', tools: ['pets_list_pets'] }]), { fetch: s.fetchFn })
    assert.equal(ts.instructions, '## w\n\nWhen w.\n\nTools: pets_list_pets\nRead it as the MCP resource skill://w/SKILL.md.\n\n## Pets\n\nPets have an id and a name.')
    assert.equal(ts.guide, '## Pets\n\nPets have an id and a name.')
    assert.deepEqual(ts.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.equal(ts.skills[0].body, 'SECRET BODY\n\nTools: pets_list_pets')
  })

  it('keeps serving when a body is unreachable', async () => {
    const ts = await load(skilled([{ name: 'w', description: 'When w.', href: 'gone.md' }]), { fetch: bodies({}).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['pets_list_pets', 'pets_get_pet'])
    assert.match(ts.skills[0].error!, /HTTP 404 \(https:\/\/api\.test\/v1\/gone\.md\)/)
  })
})
```

In `test/load.test.ts`, update the two exact instructions expectations:

- line 26 → `'## workflow\n\nStart with list_pets, then get_pet.\n\nRead it as the MCP resource skill://workflow/SKILL.md.\n\n## Pets\n\nPets have an id and a name.'`
- line 37 → `'## workflow\n\nCommencez par list_pets.\n\nRead it as the MCP resource skill://workflow/SKILL.md.\n\n## editing\n\nUse create_pet only when asked.\n\nRead it as the MCP resource skill://editing/SKILL.md.\n\n## Pets\n\nPets have an id and a name.'`

In `test/snapshot.test.ts`, add `import { digestOf } from '../src/skills.ts'` and replace the line asserting `a.skills` with:

```ts
    assert.deepEqual(a.skills, [{ id: 'workflow', name: 'workflow', description: 'Start with list_pets, then get_pet.', digest: digestOf('Start with list_pets, then get_pet.') }])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test test/load.test.ts test/snapshot.test.ts`
Expected: FAIL — `load` still imports the removed `buildSkills` (module error), so every test of both files fails.

- [ ] **Step 3: Implement**

In `src/load.ts`:

1. Replace `import { buildSkills, editorSkill } from './skills.ts'` with:

```ts
import { resolveSkills, defaultSkillFetcher, editorSkill, skillEntries } from './skills.ts'
```

and add `SkillBodyFetcher` to the type import from `./types.ts`.

2. In `interface LoadOptions`, add after `baseUrl?: string`:

```ts
  /** the URL the document was fetched from, for relative skill links; set automatically when `spec` is a URL */
  documentUrl?: string
  /** how linked skill bodies are read; the composer passes its cache, the default fetches with `fetch` */
  skillBodies?: SkillBodyFetcher
```

3. In `buildInstructions`, delete the `for (const skill of root.skills ?? []) { … }` loop and the `root` and `selected` constants it used, keeping the tag loop, and set its doc comment to: `/** The document's own guide: the skill text of the tags its selected operations carry. Skills are listed separately, by skillEntries. */`

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
  const guide = buildInstructions(doc, profiles, ops, o.locale)
  const instructions = [skillEntries(skills), guide].filter(Boolean).join('\n\n')
  return { profiles, instructions, guide, tools, skills }
```

In `src/snapshot.ts`, change the `skills` type to `{ id: string, name: string, description: string, digest: string }[]` and the mapping to `toolSet.skills.map(s => ({ id: s.id, name: s.name, description: s.description, digest: s.digest }))`.

- [ ] **Step 4: Run the tests**

Run: `NODE_ENV=test node --test --test-force-exit test/*.test.ts test/evals/*.test.ts`
Expected: PASS except the files that go through the composer — `compose.test.ts`, `bin.test.ts`, the composer tests of `adapters-mcp.test.ts`, and the "arm C" test of `test/evals/arms.test.ts` — which still import `buildSkills` through `compose.ts` until Task 4, and the known "arm A" failure. `test/editor-group.test.ts` and `test/data-fair.test.ts` must pass (they assert `/dataset_line/` and `/^## workflow/` in the instructions, both still true).

- [ ] **Step 5: Commit**

```bash
git add src/load.ts src/snapshot.ts test/load.test.ts test/snapshot.test.ts
git commit -m "feat(load): linked skills, instructions listing skills without their bodies"
```

---

### Task 4: Skills in the composer

**Files:**
- Modify: `src/compose.ts` (`fetchConditional`, `createComposer`: cache, `loadDoc`, `build`, `refresh`, `services`)
- Test: `test/compose.test.ts`

**Interfaces:**
- Consumes: `resolveSkills`, `skillEntries` (Task 2); `LoadOptions.documentUrl/skillBodies`, `ToolSet.guide` (Task 3).
- Produces: composed instructions whose entries point to `skill://<service>/<name>/SKILL.md`; `ServiceStatus.warnings` entries `skill <name>: <error>` on both composer-level and composition statuses.

- [ ] **Step 1: Let the test stack serve text**

In `test/compose.test.ts`, in `stack()`: change the map's value type to `{ body: unknown, etag: string, text?: boolean }`; add after `const set = …`:

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

Replace the assertion at `test/compose.test.ts:73` with:

```ts
    assert.match(full.toolSet.instructions, /^## cross-booking\n\nFind a pet, then book a vet\.\n\nRead it as the MCP resource skill:\/\/cross-booking\/SKILL\.md\.\n\n# Pets\n\n## workflow\n\n[^\n]+\n\nRead it as the MCP resource skill:\/\/pets\/workflow\/SKILL\.md\./)
```

and append inside `describe('createComposer', …)`:

```ts
  it('reads linked skill bodies once, revalidates them on refresh, and notifies a change', async () => {
    const s = base()
    s.set(PETS, { ...petstore, 'x-agent': { ...petstore['x-agent'], skills: [{ name: 'workflow', description: 'When pets.', href: 'skills/workflow.md' }] } })
    s.setText('https://pets.test/skills/workflow.md', 'Version 1.')
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'])
    const body = () => c.toolSet.skills.find(x => x.id === 'pets/workflow')!.body
    assert.equal(body(), 'Version 1.')
    await composer.compose(['full'])
    assert.equal(s.hits['https://pets.test/skills/workflow.md'], 1, 'one fetch for every composition')
    let notified = 0
    c.onChange(() => notified++)
    assert.equal(await composer.refresh(), false, 'an unchanged body is a 304')
    s.setText('https://pets.test/skills/workflow.md', 'Version 2.')
    assert.equal(await composer.refresh(), true)
    assert.equal(notified, 1)
    assert.equal(body(), 'Version 2.')
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test --test-force-exit test/compose.test.ts`
Expected: FAIL — `compose.ts` still imports the removed `buildSkills` (module error).

- [ ] **Step 4: Implement**

In `src/compose.ts`:

1. Replace `import { buildSkills } from './skills.ts'` with `import { resolveSkills, skillEntries } from './skills.ts'`, and add `SkillBodyFetcher` and `AgentSkill` to the type import from `./types.ts`.

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
  // Every skill of a document, whatever the request (every profile its skills name is selected):
  // what a service's status reports.
  const skillWarnings = async (skills: AgentSkill[] | undefined, base: string | undefined): Promise<string[]> =>
    (await resolveSkills(skills, new Set((skills ?? []).flatMap(s => s.profiles ?? [])), locale, base, skillBodies))
      .filter(s => s.error).map(s => `skill ${s.name}: ${s.error}`)
```

4. Extend `interface CachedDoc` with `skillWarnings?: string[]`, and in `loadDoc`, after the successful `entry.value = await loadSpec(entry.value, fetchFn)`, add:

```ts
        // fetched with the document, so a broken link shows in the service status at startup
        entry.skillWarnings = await skillWarnings(entry.value['x-agent']?.skills, entry.url)
```

5. In `build`:
   - replace `skills.push(...buildSkills(current.skills, indexSelected, locale))` and the following `for (const s of skills) sections.push(…)` line with:

```ts
    skills.push(...await resolveSkills(current.skills, indexSelected, locale, indexEntry.url || undefined, skillBodies))
    if (skills.length) sections.push(skillEntries(skills))
```

   - in the `load(d.value, { … })` call, add `documentUrl: d.url, skillBodies` to the options object;
   - replace `if (ts.instructions) sections.push(`# ${d.value.info?.title ?? d.id}\n\n${ts.instructions}`)` and the `skills.push(...ts.skills.map(…))` line with:

```ts
      const serviceSkills = ts.skills.map(s => ({ ...s, id: `${d.id}/${s.id}` }))
      skills.push(...serviceSkills)
      const serviceText = [skillEntries(serviceSkills), ts.guide].filter(Boolean).join('\n\n')
      if (serviceText) sections.push(`# ${d.value.info?.title ?? d.id}\n\n${serviceText}`)
      const failed = ts.skills.filter(s => s.error).map(s => `skill ${s.name}: ${s.error}`)
      if (failed.length) status.warnings = [...(status.warnings ?? []), ...failed]
```

6. In `refresh`, after the documents are revalidated and before `if (!changed) return false`, add:

```ts
    for (const entry of skillCache.values()) {
      if (await fetchConditional(entry, fetchFn, body => body as string, readText)) changed = true
    }
```

7. In the `services` getter, after the vocabulary warnings are attached, add:

```ts
        const failed = d.skillWarnings ?? []
        if (failed.length) status.warnings = [...(status.warnings ?? []), ...failed]
```

- [ ] **Step 5: Run the tests**

Run: `NODE_ENV=test node --test --test-force-exit test/*.test.ts test/evals/*.test.ts && npm run check-types && npm run lint`
Expected: PASS except the known "arm A". Tool lists are unchanged everywhere (no tool is generated); the adapter test comparing `client.getInstructions()` with the composition's instructions still holds.

- [ ] **Step 6: Commit**

```bash
git add src/compose.ts test/compose.test.ts
git commit -m "feat(compose): cached linked skills, revalidated on refresh, with warnings"
```

---

### Task 5: Serving a skill whose body failed

**Files:**
- Modify: `src/adapters/mcp.ts` (`toMcpServer`)
- Test: `test/adapters-mcp.test.ts`

**Interfaces:**
- Consumes: `Skill.error` (Task 2), `skillUri` (Task 2).

- [ ] **Step 1: Write the failing test**

Append inside `describe('mcp adapter over a tool set (in-memory, 2025 era)', …)`. The file's `inMemory()` helper builds its server from a tool set; if it takes no argument, change its signature to `inMemory (toolSet?: ToolSet)` and default to the tool set it builds today.

```ts
  it('lists a skill whose body failed as a resource that answers an error, and leaves it out of skills/list', async () => {
    const toolSet = await load({
      ...structuredClone(petstore),
      servers: [{ url: 'https://api.test/v1' }],
      'x-agent': { ...petstore['x-agent'], skills: [{ name: 'ok', description: 'Fine.' }, { name: 'gone', description: 'Broken.', href: 'gone.md' }] }
    }, { fetch: (async () => new Response('no', { status: 404 })) as unknown as typeof fetch })
    const { client } = await inMemory(toolSet)
    const { resources } = await client.listResources()
    assert.deepEqual(resources.map(r => r.uri), ['skill://ok/SKILL.md', 'skill://gone/SKILL.md'])
    const listed = await client.request({ method: 'skills/list', params: {} }, SkillsList)
    assert.deepEqual(listed.skills.map((s: any) => s.frontmatter.name), ['ok'])
    await assert.rejects(client.readResource({ uri: 'skill://gone/SKILL.md' }), (err: any) => /HTTP 404 \(https:\/\/api\.test\/v1\/gone\.md\)/.test(err.message))
    await assert.rejects(client.request({ method: 'skills/get', params: { uri: 'skill://gone/SKILL.md' } }, z.any()), (err: any) => err.code === -32602)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `NODE_ENV=test node --test --test-force-exit --test-name-pattern="body failed" test/adapters-mcp.test.ts`
Expected: FAIL — `skill://gone/SKILL.md` is listed in `skills/list` and its read returns an empty body.

- [ ] **Step 3: Implement**

In `src/adapters/mcp.ts`, `toMcpServer`:

1. Add `skillUri` to the import from `../skills.ts`.

2. Replace `const skills = toolSet.skills.map(renderSkillFile)` and `const byUri = …` with:

```ts
  // A skill whose body could not be read has no digest to publish in the manifest; its resource
  // stays listed and answers the error, so an agent following an instructions entry learns why.
  const skills = toolSet.skills.filter(s => !s.error).map(renderSkillFile)
  const byUri = new Map(skills.map(s => [s.uri, s]))
  const failed = new Map(toolSet.skills.filter(s => s.error).map(s => [skillUri(s), s]))
```

3. In `resources/list`, append the failed skills after the served ones:

```ts
    resources: [
      ...skills.map(s => ({ uri: s.uri, name: s.frontmatter.name, description: s.frontmatter.description, mimeType: 'text/markdown' })),
      ...[...failed.entries()].map(([uri, s]) => ({ uri, name: s.name, description: s.description, mimeType: 'text/markdown' }))
    ]
```

4. In `resources/read`, before the `if (!s) throw …` line, add:

```ts
    const broken = failed.get(req.params.uri)
    if (broken) throw new ProtocolError(INTERNAL_ERROR, `The skill ${broken.id} could not be read: ${broken.error}`)
```

and add `INTERNAL_ERROR` to the import that provides `INVALID_PARAMS` (both come from the SDK's error codes).

- [ ] **Step 4: Run the tests**

Run: `NODE_ENV=test node --test --test-force-exit test/*.test.ts test/evals/*.test.ts && npm run check-types`
Expected: PASS except the known "arm A".

- [ ] **Step 5: Commit**

```bash
git add src/adapters/mcp.ts test/adapters-mcp.test.ts
git commit -m "feat(mcp): a skill whose body failed answers its error instead of an empty body"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/x-agent.md` (section "Root"), `README.md` (sections "Skills" and "Composing a deployment"), `skills/openapi-mcp/SKILL.md` ("The annotation at a glance")

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
  `instructions`. The body is read on demand as the `skill://…/SKILL.md` resource: inline in
  `body`, or in a markdown file linked by `href` (localized; relative to the URL the document was
  fetched from, or to `servers[0].url` for a document passed as an object). `href` and `body` are
  exclusive; with neither, the description is the body. A linked file's frontmatter is ignored.
  `profiles` filters, `tools` adds a `Tools: …` line. The name follows the Agent Skills format
  (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters) and becomes the last segment of
  `skill://…/<name>/SKILL.md`.
```

- [ ] **Step 2: `README.md`**

Replace the body of the "## Skills" section with:

```markdown
Skills follow the Agent Skills disclosure levels. The MCP `instructions` list each selected skill
by name and description, with the resource to read; bodies never go there. A body is served as
`skill://<service-id>/<name>/SKILL.md` through `resources/read`, and through the skills extension
(`io.modelcontextprotocol/skills`: `skills/list`, `skills/get`, with a SHA-256 manifest).

A body is inline (`body`) or linked (`href`, a markdown file next to the document). `load()` reads
linked bodies with its `fetch`; a composer caches them with conditional requests and revalidates
them on `refresh()`. A body that cannot be read keeps the skill listed: its resource answers the
error, the service status carries a warning, and the skills manifest leaves it out.

### Upgrading to 0.4.0

A skill's `description` is now at most 1024 characters and is never split into paragraphs. Move a
long text to `body` (or to a file served next to the document, referenced by `href`) and write a
one- or two-sentence `description`. The instructions now list skills instead of embedding them,
and golden snapshots gain each skill's `digest`.
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
git commit -m "docs: linked skills and the 0.4.0 upgrade"
```
