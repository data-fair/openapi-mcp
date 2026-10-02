# Operation Views, Body Allow-list and Profile Vocabulary Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one OpenAPI operation be exposed as several tools at different profile tiers, each with its own allow-list of request body fields, and make the composer report service profiles that the deployment index does not declare.

**Architecture:** An operation's `x-agent` may become an array of **views**; `resolveOperations` yields one `ResolvedOperation` per view, so everything downstream (input building, lint, snapshot, rendering) already works per tool. A new operation key `bodyFields` prunes the request body schema in `buildInput` before the `flat`/`compact` branch. The composer compares each document's declared profiles with the index's and attaches `warnings` to the service status.

**Tech Stack:** TypeScript run natively by Node 24 (type stripping), `node:test`, Ajv 2020, eslint (neostandard via `@data-fair/lib-utils`).

**Spec:** `~/data-fair/data-fair_chore-structure-openapi-cp/docs/architecture/agent-profiles.md` (data-fair repository, branch `chore-structure-openapi-cp`), section 7 "openapi-mcp" and section 4 rule 4. This plan is rollout step 1 of that document.

## Global Constraints

- Views: "An operation's `x-agent` may be an array. Every element then needs an explicit `name`, unique within the array."
- Editor references: "`editor.readOperation` and `editor.schemaOperation` keep pointing at the raw operation and ignore views."
- Body allow-list: "the schema is pruned before both `flat` and `compact` modes, so the compact listing and the local validation agree. An allow-list rather than a deny-list."
- Vocabulary check: "The composer reports a service that declares a profile the index does not declare." Reported as a warning on the service status — the service keeps serving.
- A single-object `x-agent` keeps behaving exactly as today: no existing test may change except the one whole-object status assertion in `test/compose.test.ts` that gains `warnings` (Task 4).
- Work on branch `feat-agent-views` of `~/data-fair/openapi-mcp`. Run tests with `npm test`; the full gate is `npm run quality` (lint + `tsc` + tests).
- Code style: no semicolons, 2-space indent, single quotes (neostandard). Comments explain why, in full sentences, as in the surrounding code.

## Review Focus

1. A view array where one view has no `name`, or two views share one → `load` fails with the JSON path of the view, not a later "duplicate tool names" error that depends on the requested profiles. (Task 1)
2. A profile set selecting two views of one operation (`manage` includes `write`) → two distinct tools, each with its own body fields and annotations. (Task 2)
3. A `compact` view with `bodyFields` receiving a body that carries a field outside the list → rejected locally with "Invalid body", no request sent. (Task 3)
4. `bodyFields` naming a property the body does not declare, or set on an operation whose body is not an object → `load` fails naming the tool. (Task 3)
5. An index declaring no profiles at all → no warning for any service (nothing to check against). (Task 4)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/types.ts` | vocabulary types | `bodyFields` on `AgentOperation`; `AgentOperationAnnotation` type |
| `src/vocabulary/schema.ts` | JSON schema of each `x-agent` scope | `bodyFields` in `operationSchema` |
| `src/vocabulary/validate.ts` | validates every `x-agent` in a document | arrays of views, name rules |
| `src/spec.ts` | resolves annotated operations | one `ResolvedOperation` per view; `resolveOperationById` ignores views |
| `src/input.ts` | builds a tool's input schema and bindings | `pickBody` applied before flat/compact |
| `src/compose.ts` | merges services per profile set | `ServiceStatus.warnings`, vocabulary comparison |
| `test/fixtures/views.json` | a document with a two-view PATCH | create |
| `test/vocabulary.test.ts`, `test/spec.test.ts`, `test/input.test.ts`, `test/load.test.ts`, `test/compose.test.ts` | tests | extend |
| `docs/x-agent.md`, `README.md`, `skills/openapi-mcp/SKILL.md` | user documentation | describe views, `bodyFields`, warnings |

---

### Task 1: Vocabulary — views and `bodyFields`

**Files:**
- Modify: `src/types.ts` (interface `AgentOperation`, around line 33)
- Modify: `src/vocabulary/schema.ts` (`operationSchema`, around line 68)
- Modify: `src/vocabulary/validate.ts` (`validateVocabulary`, line 62)
- Test: `test/vocabulary.test.ts`

**Interfaces:**
- Produces: `AgentOperation.bodyFields?: string[]`; `type AgentOperationAnnotation = AgentOperation | AgentOperation[]` exported from `src/types.ts` (and therefore from the package root, which re-exports `types.ts`). Validation error messages: `x-agent invalid at <opPath>/<i>: every view of an operation needs a name`, `x-agent invalid at <opPath>/<i>: duplicate view name "<name>"`, `x-agent invalid at <opPath>: an array of views needs at least one view`.

- [ ] **Step 1: Write the failing tests**

Append to `test/vocabulary.test.ts`:

```ts
const viewsDoc = (views: unknown) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: { '/things/{id}': { patch: { operationId: 'patchThing', 'x-agent': views } } }
})

describe('operation views', () => {
  it('accepts an array of named views with body allow-lists', () => {
    assert.doesNotThrow(() => validateVocabulary(viewsDoc([
      { name: 'update_thing', profiles: ['write'], bodyFields: ['title'] },
      { name: 'publish_thing', profiles: ['manage'], bodyFields: ['publicationSites'] }
    ])))
  })
  it('requires a name on every view, naming the view', () => {
    assert.throws(() => validateVocabulary(viewsDoc([{ name: 'update_thing' }, { profiles: ['manage'] }])), /patch\/1: every view of an operation needs a name/)
  })
  it('refuses two views with the same name', () => {
    assert.throws(() => validateVocabulary(viewsDoc([{ name: 'thing' }, { name: 'thing' }])), /patch\/1: duplicate view name "thing"/)
  })
  it('refuses an empty array', () => {
    assert.throws(() => validateVocabulary(viewsDoc([])), /an array of views needs at least one view/)
  })
  it('validates each view against the operation vocabulary, naming its index', () => {
    assert.throws(() => validateVocabulary(viewsDoc([{ name: 'a' }, { name: 'b', bogus: 1 }])), /patch\/1: .*bogus/)
  })
  it('refuses an empty bodyFields', () => {
    assert.throws(() => validateVocabulary(viewsDoc({ name: 'a', bodyFields: [] })), /x-agent invalid/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test --test-name-pattern="operation views" test/vocabulary.test.ts`
Expected: FAIL — the array is rejected by `operationSchema` ("must be object"), and `bodyFields` is an unknown property.

- [ ] **Step 3: Add the type**

In `src/types.ts`, inside `interface AgentOperation`, after the `body?: 'flat' | 'compact'` member:

```ts
  /**
   * Allow-list of request body properties this tool offers. The body schema is pruned to them
   * before `body` mode applies, and extra properties are refused: a field added to the API
   * later is exposed nowhere until an annotation places it.
   */
  bodyFields?: string[]
```

After the `AgentOperation` interface:

```ts
/**
 * An operation's `x-agent`: one tool, or several views of the operation, each its own tool —
 * a PATCH whose fields belong to different profile tiers is offered as one tool per tier.
 */
export type AgentOperationAnnotation = AgentOperation | AgentOperation[]
```

- [ ] **Step 4: Add `bodyFields` to the operation schema**

In `src/vocabulary/schema.ts`, in `operationSchema.properties`, after `body: { enum: ['flat', 'compact'] },`:

```ts
    bodyFields: { type: 'array', items: { type: 'string' }, minItems: 1, uniqueItems: true },
```

- [ ] **Step 5: Validate arrays of views**

In `src/vocabulary/validate.ts`, add the import and a function after `checkParams`:

```ts
import type { AgentOperation, JsonSchema } from '../types.ts'
```

(replace the existing `import type { JsonSchema } from '../types.ts'`)

```ts
/**
 * An operation annotation is one view or an array of views. Every view of an array is a tool
 * of its own, so each needs a name, unique within the array: the views of one PATCH are
 * selected together whenever a profile includes another, and a clash found only for some
 * profile sets would surface far from the annotation that caused it.
 */
function checkOperation (value: unknown, path: string) {
  if (!Array.isArray(value)) return check('operation', value, path)
  if (!value.length) throw new Error(`x-agent invalid at ${path}: an array of views needs at least one view`)
  const names = new Set<string>()
  value.forEach((view, i) => {
    check('operation', view, `${path}/${i}`)
    const name = (view as AgentOperation).name
    if (!name) throw new Error(`x-agent invalid at ${path}/${i}: every view of an operation needs a name`)
    if (names.has(name)) throw new Error(`x-agent invalid at ${path}/${i}: duplicate view name "${name}"`)
    names.add(name)
  })
}
```

In `validateVocabulary`, replace:

```ts
      if (op['x-agent'] !== undefined) check('operation', op['x-agent'], opPath)
```

with:

```ts
      if (op['x-agent'] !== undefined) checkOperation(op['x-agent'], opPath)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `NODE_ENV=test node --test test/vocabulary.test.ts`
Expected: PASS, including every pre-existing test of the file.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/vocabulary/schema.ts src/vocabulary/validate.ts test/vocabulary.test.ts
git commit -m "feat(vocabulary): operation views and a body allow-list"
```

---

### Task 2: Resolution — one tool per view

**Files:**
- Create: `test/fixtures/views.json`
- Modify: `src/spec.ts` (`resolveOperations` lines 115-143, `resolveOperationById` lines 150-162)
- Test: `test/spec.test.ts`, `test/load.test.ts`

**Interfaces:**
- Consumes: `AgentOperationAnnotation`, `AgentOperation.bodyFields` (Task 1).
- Produces: `resolveOperations` returns one `ResolvedOperation` per selected view, in view order; `op.agent` is the view (so `op.agent.bodyFields` is set per view). `resolveOperationById` returns the operation with `agent: {}` when its annotation is an array. The fixture `test/fixtures/views.json` is used by Tasks 3.

- [ ] **Step 1: Create the fixture**

`test/fixtures/views.json`:

```json
{
  "openapi": "3.1.0",
  "info": { "title": "Things", "version": "1" },
  "servers": [{ "url": "https://things.test/api" }],
  "x-agent": {
    "namePrefix": "t_",
    "profiles": { "write": { "title": "Write" }, "manage": { "title": "Manage", "includes": ["write"] } }
  },
  "paths": {
    "/things/{id}": {
      "parameters": [{ "in": "path", "name": "id", "required": true, "schema": { "type": "string" } }],
      "patch": {
        "operationId": "patchThing",
        "x-agent": [
          { "name": "update_thing", "profiles": ["write"], "description": "Edit the title and description of a thing.", "bodyFields": ["title", "description"] },
          { "name": "publish_thing", "profiles": ["manage"], "description": "Choose the sites a thing is published on.", "bodyFields": ["publicationSites"], "annotations": { "idempotentHint": true } }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["title"],
                "properties": {
                  "title": { "type": "string" },
                  "description": { "type": "string" },
                  "publicationSites": { "type": "array", "items": { "type": "string" } }
                }
              }
            }
          }
        },
        "responses": { "200": { "description": "ok", "content": { "application/json": { "schema": { "type": "object", "properties": { "id": { "type": "string" } } } } } } }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

In `test/spec.test.ts`, add after the existing `const petstore = …` line:

```ts
const views = JSON.parse(await readFile(new URL('./fixtures/views.json', import.meta.url), 'utf8'))
```

and append:

```ts
describe('operation views', () => {
  const doc = inlineRefs(structuredClone(views))
  it('resolves one operation per selected view, in view order', () => {
    assert.deepEqual(resolveOperations(doc, 'write').map(o => o.toolName), ['t_update_thing'])
    const both = resolveOperations(doc, 'manage')
    assert.deepEqual(both.map(o => o.toolName), ['t_update_thing', 't_publish_thing'])
    assert.deepEqual(both.map(o => o.operationId), ['patchThing', 'patchThing'])
    assert.deepEqual(both.map(o => o.agent.bodyFields), [['title', 'description'], ['publicationSites']])
    assert.deepEqual(both[1].agent.annotations, { idempotentHint: true })
  })
  it('resolves the raw operation for an editor reference, ignoring the views', () => {
    const op = resolveOperationById(doc, 'patchThing')!
    assert.equal(op.toolName, 't_patch_thing')
    assert.equal(op.agent.bodyFields, undefined)
    assert.equal(op.agent.profiles, true)
  })
})
```

In `test/load.test.ts`, add after the existing `const petstore = …` line:

```ts
const views = JSON.parse(await readFile(new URL('./fixtures/views.json', import.meta.url), 'utf8'))
```

and append:

```ts
describe('load — operation views', () => {
  it('builds one tool per view, each with its own description and annotations', async () => {
    const ts = await load(views, { profiles: ['manage'], fetch: stub(() => json({ id: '1' })).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['t_update_thing', 't_publish_thing'])
    assert.equal(ts.tools[1].description, 'Choose the sites a thing is published on.')
    assert.deepEqual(ts.tools[1].annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true })
  })
  it('offers only the views of the requested profiles', async () => {
    const ts = await load(views, { profiles: ['write'], fetch: stub(() => json({ id: '1' })).fetchFn })
    assert.deepEqual(ts.tools.map(t => t.name), ['t_update_thing'])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test --test-name-pattern="views" test/spec.test.ts test/load.test.ts`
Expected: FAIL — the array is spread as one annotation (`agent` is an array), so the names come out as `t_patch_thing` and profile matching misbehaves.

- [ ] **Step 4: Resolve per view**

In `src/spec.ts`, add `AgentOperationAnnotation` to the type import:

```ts
import type { JsonSchema, AgentOperation, AgentOperationAnnotation, AgentParamOverride, AgentRoot, AgentTag, ResolvedOperation, ResolvedParam } from './types.ts'
```

In `resolveOperations`, replace the body of the inner `for (const method of METHODS)` loop:

```ts
      const op = item?.[method]
      if (!op || op['x-agent'] === undefined) continue
      const agent: AgentOperation = op['x-agent']
      const tags: string[] = op.tags ?? []
      const tagProfiles = tags.map(t => tagAgents.get(t)?.profiles).find(p => p !== undefined)
      const opProfiles = agent.profiles ?? tagProfiles ?? true
      if (!matchesProfiles(opProfiles, selected)) continue
      if (!op.operationId) throw new Error(`operation ${method.toUpperCase()} ${path} has x-agent but no operationId`)

      out.push(resolveOne(path, item, method, op, agent, opProfiles, prefix))
```

with:

```ts
      const op = item?.[method]
      if (!op || op['x-agent'] === undefined) continue
      const annotation: AgentOperationAnnotation = op['x-agent']
      const tags: string[] = op.tags ?? []
      const tagProfiles = tags.map(t => tagAgents.get(t)?.profiles).find(p => p !== undefined)
      // Each view of an operation is a tool of its own, selected by its own profiles.
      for (const agent of Array.isArray(annotation) ? annotation : [annotation]) {
        const opProfiles = agent.profiles ?? tagProfiles ?? true
        if (!matchesProfiles(opProfiles, selected)) continue
        if (!op.operationId) throw new Error(`operation ${method.toUpperCase()} ${path} has x-agent but no operationId`)
        out.push(resolveOne(path, item, method, op, agent, opProfiles, prefix))
      }
```

In `resolveOperationById`, replace:

```ts
      const agent: AgentOperation = op['x-agent'] ?? {}
```

with:

```ts
      // An editor reads or compiles the raw operation; views are tools, not data sources.
      const annotation: AgentOperationAnnotation | undefined = op['x-agent']
      const agent: AgentOperation = annotation && !Array.isArray(annotation) ? annotation : {}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, every file.

- [ ] **Step 6: Commit**

```bash
git add src/spec.ts test/fixtures/views.json test/spec.test.ts test/load.test.ts
git commit -m "feat: resolve one tool per operation view"
```

---

### Task 3: Body allow-list

**Files:**
- Modify: `src/input.ts` (`buildInput`, lines 69-117)
- Test: `test/input.test.ts`, `test/load.test.ts`

**Interfaces:**
- Consumes: `op.agent.bodyFields` per view (Tasks 1-2), `test/fixtures/views.json` (Task 2).
- Produces: `buildInput` exposes only the allowed body properties in flat mode, and returns a pruned `bodySchema` (with `additionalProperties: false`) in compact mode. Load-time errors: `<toolName>: bodyFields needs an object request body with properties`, `<toolName>: bodyFields names properties the request body does not declare: <names>`.

- [ ] **Step 1: Write the failing tests**

In `test/input.test.ts`, add after the existing fixture lines:

```ts
const views = inlineRefs(JSON.parse(await readFile(new URL('./fixtures/views.json', import.meta.url), 'utf8')))
const [updateThing, publishThing] = resolveOperations(views, 'manage')
```

and append:

```ts
describe('buildInput — bodyFields', () => {
  it('exposes only the allowed body properties in flat mode, keeping their required flags', () => {
    const update = buildInput(updateThing, 'en')
    assert.deepEqual(Object.keys(update.inputSchema.properties), ['id', 'title', 'description'])
    assert.deepEqual(update.inputSchema.required, ['id', 'title'])
    const publish = buildInput(publishThing, 'en')
    assert.deepEqual(Object.keys(publish.inputSchema.properties), ['id', 'publicationSites'])
    assert.deepEqual(publish.inputSchema.required, ['id'])
  })
  it('prunes the compact listing and the validation schema alike, refusing other properties', () => {
    const op = { ...publishThing, agent: { ...publishThing.agent, body: 'compact' as const } }
    const { inputSchema, bodySchema } = buildInput(op, 'en')
    assert.deepEqual(Object.keys(bodySchema!.properties), ['publicationSites'])
    assert.equal(bodySchema!.additionalProperties, false)
    assert.equal(bodySchema!.required, undefined)
    assert.match(inputSchema.properties.body.description, /publicationSites/)
    assert.doesNotMatch(inputSchema.properties.body.description, /title/)
  })
  it('fails on a property the body does not declare', () => {
    const op = { ...publishThing, agent: { ...publishThing.agent, bodyFields: ['publicationSites', 'nope'] } }
    assert.throws(() => buildInput(op, 'en'), /t_publish_thing: bodyFields names properties the request body does not declare: nope/)
  })
  it('fails on a body that is not an object with properties', () => {
    const op = { ...publishThing, requestBody: { schema: { type: 'array', items: { type: 'string' } }, required: true } }
    assert.throws(() => buildInput(op, 'en'), /t_publish_thing: bodyFields needs an object request body with properties/)
  })
})
```

In `test/load.test.ts`, append inside `describe('load — operation views', …)`:

```ts
  it('sends only the allowed fields, and refuses others before any request', async () => {
    const s = stub(() => json({ id: '1' }))
    const ts = await load(views, { profiles: ['manage'], fetch: s.fetchFn })
    const publish = ts.tools.find(t => t.name === 't_publish_thing')!
    const refused = await publish.execute({ id: '1', publicationSites: ['portal-a'], title: 'x' })
    assert.equal(refused.isError, true)
    assert.match(refused.text, /^Invalid parameters/)
    assert.equal(s.calls.length, 0)
    const ok = await publish.execute({ id: '1', publicationSites: ['portal-a'] })
    assert.ok(!ok.isError, ok.text)
    assert.equal(s.calls[0].method, 'PATCH')
    assert.equal(s.calls[0].url, 'https://things.test/api/things/1')
    assert.deepEqual(await s.calls[0].json(), { publicationSites: ['portal-a'] })
  })
  it('refuses a compact body carrying a field outside the view, before any request', async () => {
    const doc = structuredClone(views)
    doc.paths['/things/{id}'].patch['x-agent'][1].body = 'compact'
    const s = stub(() => json({ id: '1' }))
    const ts = await load(doc, { profiles: ['manage'], fetch: s.fetchFn })
    const publish = ts.tools.find(t => t.name === 't_publish_thing')!
    const refused = await publish.execute({ id: '1', body: { publicationSites: ['portal-a'], title: 'x' } })
    assert.equal(refused.isError, true)
    assert.match(refused.text, /^Invalid body/)
    assert.equal(s.calls.length, 0)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test --test-name-pattern="bodyFields|views" test/input.test.ts test/load.test.ts`
Expected: FAIL — every body property is exposed (`title` and `description` appear on `publish`), and the compact body accepts `title`.

- [ ] **Step 3: Implement `pickBody` and use it in `buildInput`**

In `src/input.ts`, add before `export function buildInput`:

```ts
/**
 * A view's body allow-list: the request body schema reduced to the named properties. Applied
 * before the flat/compact choice so the flat properties, the compact listing and the local
 * validation agree; `additionalProperties: false` keeps a compact body from carrying a field
 * the view does not offer. Composition keywords of the original schema are dropped on purpose:
 * an allow-list that a `oneOf` could widen again would not be one.
 */
function pickBody (op: ResolvedOperation): ResolvedOperation['requestBody'] {
  const fields = op.agent.bodyFields
  if (!op.requestBody || !fields) return op.requestBody
  const schema = op.requestBody.schema
  if (schema.type !== 'object' || !schema.properties) throw new Error(`${op.toolName}: bodyFields needs an object request body with properties`)
  const missing = fields.filter(f => !(f in schema.properties))
  if (missing.length) throw new Error(`${op.toolName}: bodyFields names properties the request body does not declare: ${missing.join(', ')}`)
  const picked: JsonSchema = {
    type: 'object',
    properties: Object.fromEntries(fields.map(f => [f, schema.properties[f]])),
    additionalProperties: false
  }
  if (schema.description) picked.description = schema.description
  const required = (schema.required ?? []).filter((r: string) => fields.includes(r))
  if (required.length) picked.required = required
  return { ...op.requestBody, schema: picked }
}
```

In `buildInput`, add as the first line of the body-handling part, right before the comment `// In compact mode the body is one property described by a listing, …`:

```ts
  const requestBody = pickBody(op)
```

Then, in the rest of that body-handling block (the `if (op.requestBody && op.agent.body === 'compact')` branch and its `else if (op.requestBody)` branch, up to the `if (selectParam)` line), replace every `op.requestBody` with `requestBody`. The block then reads:

```ts
  const requestBody = pickBody(op)
  // In compact mode the body is one property described by a listing, and the real schema
  // is returned for the caller to validate against — a tool definition carrying data-fair's
  // 28 KB dataset body costs more than the entire six-tool explore set.
  let bodySchema: JsonSchema | undefined
  if (requestBody && op.agent.body === 'compact') {
    properties.body = {
      type: 'object',
      description: `The request body. Properties (\`?\` marks optional):\n\n${summariseSchema(requestBody.schema)}`
    }
    if (requestBody.required) required.push('body')
    bindings.push({ toolName: 'body', kind: 'body', apiName: 'body', style: undefined, explode: undefined })
    authoredDescriptions.add('body')
    bodySchema = requestBody.schema
  } else if (requestBody) {
    const body = requestBody.schema
    if (body.type === 'object' && body.properties) {
      for (const [name, schema] of Object.entries<any>(body.properties)) {
        const toolName = name in properties ? `${name}__body` : name
        properties[toolName] = schema
        if (body.required?.includes(name)) required.push(toolName)
        bindings.push({ toolName, kind: 'bodyProp', apiName: name, style: undefined, explode: undefined })
      }
    } else {
      properties.body = body
      if (requestBody.required) required.push('body')
      bindings.push({ toolName: 'body', kind: 'body', apiName: 'body', style: undefined, explode: undefined })
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, every file.

- [ ] **Step 5: Commit**

```bash
git add src/input.ts test/input.test.ts test/load.test.ts
git commit -m "feat: restrict a view's request body to an allow-list of fields"
```

---

### Task 4: Composer vocabulary warnings

**Files:**
- Modify: `src/compose.ts` (`ServiceStatus` lines 13-19, `build` lines 186-218)
- Test: `test/compose.test.ts` (new tests, and the assertion at line 107)

**Interfaces:**
- Produces: `ServiceStatus.warnings?: string[]`, set on the per-composition statuses (`Composition.services`) with the message `declares profiles absent from the index: <names in document order>`. Absent when the index declares no profiles or the document declares none outside it.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('createComposer', …)` in `test/compose.test.ts`:

```ts
  it('warns about a service declaring profiles the index does not declare, and still serves it', async () => {
    const s = base()
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'])
    assert.deepEqual(c.services.map(x => [x.id, x.status, x.warnings]), [
      ['pets', 'ok', ['declares profiles absent from the index: edit']],
      ['vets', 'ok', ['declares profiles absent from the index: edit_appointments, edit']]
    ])
  })

  it('does not warn when the index declares no profile vocabulary', async () => {
    const s = base()
    s.set(INDEX, { version: 1, services: [{ id: 'pets', openapi: PETS }, { id: 'vets', openapi: VETS }] })
    const composer = await createComposer(INDEX, { fetch: s.fetchFn })
    const c = await composer.compose(['explore'])
    assert.deepEqual(c.services.map(x => x.warnings), [undefined, undefined])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `NODE_ENV=test node --test --test-name-pattern="warn" test/compose.test.ts`
Expected: FAIL — `warnings` is `undefined` for both services in the first test.

- [ ] **Step 3: Implement**

In `src/compose.ts`, in `interface ServiceStatus`, after `reason?: string`:

```ts
  /** problems that do not stop the service from serving, e.g. profiles the index does not declare */
  warnings?: string[]
```

In `build`, right after the line `if (!d.value) { status.status = 'error'; status.reason = d.error ?? 'not loaded'; continue }` and the two lines declaring `root` and `declared`:

```ts
      // The index is the deployment's profile vocabulary, the names agent configurations are
      // written with: a document name outside it is a typo or a profile no consumer can offer.
      // Reported rather than refused, so a service keeps serving what it does declare correctly.
      const vocabulary = Object.keys(current.profiles ?? {})
      const outside = vocabulary.length ? declared.filter(p => !vocabulary.includes(p)) : []
      if (outside.length) {
        status.warnings = [`declares profiles absent from the index: ${outside.join(', ')}`]
        debug('%s %s', d.id, status.warnings[0])
      }
```

- [ ] **Step 4: Update the whole-object status assertion**

In the test `excludes the later service on a tool name collision, naming both`, replace:

```ts
    assert.deepEqual(c.services[1], { id: 'vets', openapi: VETS, status: 'error', tools: 0, reason: 'tool name collision with pets: pets_list_pets' })
```

with:

```ts
    assert.deepEqual(c.services[1], {
      id: 'vets',
      openapi: VETS,
      status: 'error',
      tools: 0,
      reason: 'tool name collision with pets: pets_list_pets',
      warnings: ['declares profiles absent from the index: edit_appointments, edit']
    })
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, every file.

- [ ] **Step 6: Commit**

```bash
git add src/compose.ts test/compose.test.ts
git commit -m "feat(compose): warn about service profiles absent from the index"
```

---

### Task 5: Documentation and the quality gate

**Files:**
- Modify: `docs/x-agent.md` (sections "Operation" line 94, "Request bodies" line 139)
- Modify: `README.md` (section "Composing a deployment")
- Modify: `skills/openapi-mcp/SKILL.md` (table "The annotation at a glance", and a new short section before "Editor tool groups")

**Interfaces:**
- Consumes: the behaviour of Tasks 1-4, described exactly as implemented (names `bodyFields`, `warnings`, the three validation messages).

- [ ] **Step 1: Document views and `bodyFields` in `docs/x-agent.md`**

In the "Operation" section, add a row to the field table after the `body` row:

```markdown
| `bodyFields` | string[] | Allow-list of request body properties this tool offers. See [Request bodies](#request-bodies). |
```

Right after that table (before "### Parameter overrides"), add:

~~~markdown
### Views: several tools from one operation

`x-agent` on an operation may be an array. Each element is a **view** — a complete operation
annotation producing a tool of its own, with its own profiles, description, annotations,
parameters and body fields. Use it when one endpoint does things of different criticity
depending on its payload, typically a PATCH editing content and governance fields:

```yaml
patch:
  operationId: patchDataset
  x-agent:
    - name: update_dataset
      profiles: [write_datasets]
      bodyFields: [title, description, keywords]
    - name: publish_dataset
      profiles: [manage_datasets]
      bodyFields: [publicationSites]
```

Every view needs a `name`, unique within the array — views of one operation are often
selected together (a profile including another), so a missing or repeated name is refused at
load with the view's JSON path. `editor.readOperation` and `editor.schemaOperation` name the
raw operation and ignore its views.
~~~

In the "Request bodies" section, append:

```markdown
`bodyFields` restricts the body to an allow-list of its properties. The schema is pruned before
the `flat`/`compact` choice, so the merged properties, the compact listing and the local
validation all agree, and any other property is refused before a request is sent. It needs an
object body with declared properties, and every listed name must be one of them; both are
checked at load. An allow-list rather than a deny-list: a property added to the API later is
offered by no tool until an annotation places it.
```

- [ ] **Step 2: Document the vocabulary warnings in `README.md`**

In "Composing a deployment", after the paragraph starting "A failing service is excluded and reported;", add:

```markdown
The index's `profiles` are the deployment's vocabulary. A service declaring a profile the index
does not declare keeps serving, and its status carries a warning
(`warnings: ['declares profiles absent from the index: …']`) — a typo in a profile name would
otherwise create a profile no consumer can present.
```

- [ ] **Step 3: Mention views in the skill**

In `skills/openapi-mcp/SKILL.md`, in the table "The annotation at a glance", change the Operation row's second cell to:

```markdown
| Operation (`paths.<p>.<method>`) | opt-in, `name`, `title`, `description`, `examples`, `annotations`, `params`, `fixed`, `body`, `bodyFields`, `response`, `editor` — or an array of such views |
```

Before the section "## Editor tool groups: eight tools instead of one body", add:

~~~markdown
## One endpoint, several tools: views

When the same operation does things of different criticity depending on its payload — a PATCH
that edits a description but also changes where a resource is published — annotate it with an
array of views instead of one object. Each view is a tool with its own `name` (required,
unique in the array), `profiles`, `annotations` and `bodyFields` allow-list:

```yaml
x-agent:
  - { name: update_dataset, profiles: [write_datasets], bodyFields: [title, description] }
  - { name: publish_dataset, profiles: [manage_datasets], bodyFields: [publicationSites] }
```

Prefer `bodyFields` (an allow-list) over trusting an agent to leave fields alone: a property
outside the list is refused before the request leaves, and a property added to the API later
is offered by no tool until someone places it. The API still enforces its own permissions —
views decide what an agent is offered, not what it is allowed.
~~~

- [ ] **Step 4: Run the full quality gate**

Run: `npm run quality`
Expected: eslint clean, `tsc` without errors, every test passing.

- [ ] **Step 5: Commit**

```bash
git add docs/x-agent.md README.md skills/openapi-mcp/SKILL.md
git commit -m "docs: operation views, bodyFields and vocabulary warnings"
```
