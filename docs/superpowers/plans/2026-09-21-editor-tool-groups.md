# Editor tool groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a group of eight json-layout form tools from an annotated OpenAPI write operation whose body schema is fetched at runtime from another operation.

**Architecture:** `@json-layout/agents` owns sessions, saving, validity and layout caching. We write one adapter: resolve the operations an `editor` annotation names, build a `SessionSpec` over them, preprocess the fetched schema the way data-fair's own form does, and wrap the package's tool descriptors so each one takes the write operation's path parameters and resolves its own session.

**Tech Stack:** TypeScript on Node 24 (native type stripping, no build step for tests), `node:test` + `node:assert/strict`, Ajv 8, `@json-layout/agents` ^0.1.0 (optional peer, lazily imported), `@json-layout/core` >= 2.10.0.

**Spec:** `docs/superpowers/specs/2026-09-21-editor-tool-groups-design.md`

## Global Constraints

- `@json-layout/agents` is an **optional peer dependency** (`^0.1.0`) and a devDependency. Every import of it, and of `@json-layout/core`, is a lazy `await import(...)` inside a function — never a top-level import. A consumer using only read tools must not need it installed.
- `@json-layout/core` must be **>= 2.10.0**: earlier versions do not export `./compat/v2`.
- A tool group is exactly **eight** tools: core's six (`getData`, `setData`, `describeState`, `setFieldValue`, `getFieldSuggestions`, `editArray`) plus `saveForm` and `reloadForm`. `includeFillFormSkill` and `includeSubAgent` stay **false**.
- Tool names are `<x-agent name>_<verb>`, produced by passing `prefixName: op.toolName + '_'` to the session. Never by string-building the verb list here.
- `allowInvalid` is left at its default (false). We add no second validity gate.
- Only `application/json` request bodies are supported.
- `Tool.execute` **never throws**. Every failure becomes `{ isError: true, text }`.
- `schemaParams` must **not** carry `arrays` — measured: it makes a fetched line fail its own schema. Nothing in the code adds it.
- **Session key**: `${op.toolName}:${each path param value, in declared order, joined by ':'}`.
- **Schema-function key**: `${schemaOp.operationId}:${the schema operation's own path param values}:${JSON.stringify(schemaParams)}`. Two sessions over the same dataset must receive the *same function object*, or `resolveCompiledLayout` recompiles per session.
- The schema closure returns the envelope `{ schema, version }`; `version` is a sha1 hex of the raw response text.
- Existing tests must keep passing: `npm run quality` (lint, `tsc`, `node --test`) is green before every commit.

---

## File Structure

**Created:**
- `src/editor/prepare-schema.ts` — a fetched JSON Schema → one `compile()` accepts. Owns `v2compat`, string-`layout` normalization, and hiding attachment / extension columns. No knowledge of operations or HTTP.
- `src/editor/operations.ts` — resolving the operations an `editor` annotation names, checking their path parameters against the write operation, and building HTTP requests for them. No knowledge of sessions.
- `src/editor/session-spec.ts` — `ResolvedOperation` + path parameters → `SessionSpec`, plus the schema-function registry that keeps one closure per distinct schema. No knowledge of tools.
- `src/editor/bridge.ts` — a package `FormTool` → our `Tool`: adds path parameters to the input schema, resolves the session, converts MCP-shaped results. No knowledge of how a `SessionSpec` is built.
- `src/editor/index.ts` — `buildEditorTools(op, doc, o)`: the only export `load.ts` uses.
- `test/editor-prepare-schema.test.ts`, `test/editor-operations.test.ts`, `test/editor-session-spec.test.ts`, `test/editor-bridge.test.ts`, `test/editor-group.test.ts`
- `test/fixtures/dataset-line-schema.json` — a fetched-schema fixture carrying every shape `prepareSchema` handles.
- `docs/superpowers/notes/2026-09-21-editor-live-check.md` — the live-run report from Task 7.

**Modified:**
- `src/types.ts` — `AgentEditor` replaces the inline `true | { readOperation?: string }`.
- `src/vocabulary/schema.ts` — the `editor` slot accepts the new object.
- `src/spec.ts` — `resolveOperationById` added; the phase-1 `editor` throw removed in Task 6.
- `src/load.ts` — editor operations produce `Tool[]`; the group's guide is appended to `instructions`.
- `package.json` — the optional peer dependency and its devDependency.

---

### Task 1: The `editor` vocabulary and its type

**Files:**
- Modify: `src/types.ts:46`
- Modify: `src/vocabulary/schema.ts:82`
- Test: `test/vocabulary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentEditor` from `src/types.ts`, used by every later task:
  ```ts
  export interface AgentEditor {
    schemaOperation?: string
    schemaParams?: Record<string, unknown>
    readOperation?: string
  }
  ```

- [ ] **Step 1: Write the failing tests**

Add to `test/vocabulary.test.ts`:

```ts
describe('editor annotation', () => {
  it('accepts the full object form', () => {
    const doc = editorDoc({ schemaOperation: 'readSchema', schemaParams: { mimeType: 'application/schema+json' }, readOperation: 'readLine' })
    assert.deepEqual(validateVocabulary(doc), [])
  })

  it('accepts the true shorthand, which means the declared body schema', () => {
    assert.deepEqual(validateVocabulary(editorDoc(true)), [])
  })

  it('accepts an object with no schemaOperation', () => {
    assert.deepEqual(validateVocabulary(editorDoc({ readOperation: 'readLine' })), [])
  })

  it('rejects an unknown key', () => {
    const findings = validateVocabulary(editorDoc({ schemaOperation: 'readSchema', schemaOperaton: 'typo' }))
    assert.equal(findings.length > 0, true)
  })
})
```

with this helper near the top of the same file:

```ts
const editorDoc = (editor: unknown) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: { '/things/{id}': { put: { operationId: 'updateThing', 'x-agent': { name: 'thing', editor } } } }
})
```

Match the existing file's import of the vocabulary validator; if it is named differently from `validateVocabulary`, use that name and keep the assertions as written.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/vocabulary.test.ts`
Expected: the `schemaOperation` and `schemaParams` cases FAIL — `additionalProperties` rejects the new keys.

- [ ] **Step 3: Widen the schema**

In `src/vocabulary/schema.ts`, replace line 82:

```ts
    editor: {
      oneOf: [
        { const: true },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            schemaOperation: { type: 'string' },
            schemaParams: { type: 'object' },
            readOperation: { type: 'string' }
          }
        }
      ]
    }
```

- [ ] **Step 4: Widen the type**

In `src/types.ts`, replace line 46 (`editor?: true | { readOperation?: string }`) with `editor?: true | AgentEditor`, and add above `AgentSkill`:

```ts
/** Names the operations a json-layout editor group reads its schema and document from. */
export interface AgentEditor {
  /** operationId whose response body IS the request body's JSON Schema; absent means the declared one */
  schemaOperation?: string
  /** fixed parameter values for that operation */
  schemaParams?: Record<string, unknown>
  /** operationId that loads the document being edited; absent means a create */
  readOperation?: string
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run quality`
Expected: lint clean, `tsc` clean, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/vocabulary/schema.ts test/vocabulary.test.ts
git commit -m "feat: the editor annotation names the operations it reads from"
```

---

### Task 2: Resolve an operation by id, regardless of profile

**Files:**
- Modify: `src/spec.ts:87-120` (extract the per-operation body, add the new export)
- Test: `test/spec.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export function resolveOperationById (doc: JsonSchema, operationId: string): ResolvedOperation | undefined
  ```
  Task 4 calls it to resolve `schemaOperation` and `readOperation`.

**Context for the implementer:** `resolveOperations(doc, profile)` walks every path/method and skips anything without `x-agent` or outside the profile. The operations an `editor` annotation names are usually neither — `readSchema` has no `x-agent` of its own. So the same per-operation resolution has to be reachable by id, with the `x-agent` and profile gates lifted. Extract it; do not copy it.

- [ ] **Step 1: Write the failing test**

Add to `test/spec.test.ts`:

```ts
describe('resolveOperationById', () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 't', version: '1' },
    paths: {
      '/datasets/{id}/schema': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'readSchema',
          parameters: [{ name: 'mimeType', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } }
        }
      }
    }
  }

  it('resolves an operation that has no x-agent at all', () => {
    const op = resolveOperationById(doc, 'readSchema')
    assert.equal(op?.operationId, 'readSchema')
    assert.equal(op?.method, 'get')
    assert.equal(op?.path, '/datasets/{id}/schema')
    assert.deepEqual(op?.params.map(p => `${p.in}:${p.name}`), ['path:id', 'query:mimeType'])
  })

  it('returns undefined for an unknown id', () => {
    assert.equal(resolveOperationById(doc, 'nope'), undefined)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/spec.test.ts`
Expected: FAIL — `resolveOperationById is not defined`.

- [ ] **Step 3: Extract and export**

In `src/spec.ts`, move the part of the inner `for (const method of METHODS)` loop that starts at the `rawParams` map (the `// path-level params first` comment) and runs down to the object pushed onto `out`, into a module-level function, and have both callers use it.

**`profiles` is computed above that point and is used in the returned `agent` field**, so it is a parameter, not something `resolveOne` recomputes — `resolveOperations` passes its tag-resolved value, `resolveOperationById` passes `agent.profiles ?? true`:

```ts
function resolveOne (path: string, item: any, method: string, op: any, agent: AgentOperation, profiles: string[] | true, prefix: string): ResolvedOperation {
  // ...the existing body verbatim, returning the ResolvedOperation instead of pushing it
}

/**
 * Resolve one operation by id with the x-agent and profile gates lifted. An `editor`
 * annotation names operations that usually have no annotation of their own, so they are
 * invisible to resolveOperations.
 */
export function resolveOperationById (doc: JsonSchema, operationId: string): ResolvedOperation | undefined {
  const prefix = (doc['x-agent'] as AgentRoot | undefined)?.namePrefix ?? ''
  for (const [path, item] of Object.entries<any>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item?.[method]
      if (op?.operationId !== operationId) continue
      const agent: AgentOperation = op['x-agent'] ?? {}
      return resolveOne(path, item, method, op, agent, agent.profiles ?? true, prefix)
    }
  }
  return undefined
}
```

Keep the `editor` throw in `resolveOperations` for now — Task 6 removes it, when there is something to remove it in favour of.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run quality`
Expected: all PASS, including the existing `spec.test.ts` and `data-fair.test.ts` cases that exercise `resolveOperations`.

- [ ] **Step 5: Commit**

```bash
git add src/spec.ts test/spec.test.ts
git commit -m "feat: resolve an operation by id regardless of profile"
```

---

### Task 3: `prepareSchema`

**Files:**
- Create: `src/editor/prepare-schema.ts`
- Create: `test/fixtures/dataset-line-schema.json`
- Test: `test/editor-prepare-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export async function prepareSchema (fetched: JsonSchema): Promise<JsonSchema>
  ```
  Task 4 awaits it inside the schema closure.

**Context for the implementer:** data-fair's own line-editing form (`data-fair/ui/src/components/dataset/form/dataset-edit-line-form.vue:70-100`) does exactly this before handing the schema to json-layout. A fetched dataset schema carries vjsf-v2 keywords, so compiling it raw logs `failed to normalize layout, use default component` and renders pickers as plain sections. `v2compat` is the fix and it now lives in `@json-layout/core/compat/v2` (core >= 2.10.0).

- [ ] **Step 1: Write the fixture**

`test/fixtures/dataset-line-schema.json` — the shapes a real fetched schema mixes:

```json
{
  "type": "object",
  "required": [],
  "properties": {
    "code_commune": { "type": "string", "title": "Code commune" },
    "note": { "type": "string", "title": "Note", "layout": "textarea" },
    "departement": {
      "type": "object",
      "title": "Département",
      "x-fromUrl": "https://example.com/departements",
      "x-itemsProp": "results",
      "x-itemTitle": "nom",
      "x-itemKey": "code"
    },
    "piece_jointe": {
      "type": "string",
      "title": "Pièce jointe",
      "x-refersTo": "http://schema.org/DigitalDocument"
    },
    "population_calculee": {
      "type": "number",
      "title": "Population calculée",
      "x-extension": "population"
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

`test/editor-prepare-schema.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compile } from '@json-layout/core'
import { prepareSchema } from '../src/editor/prepare-schema.ts'

const fetched = JSON.parse(await readFile(new URL('./fixtures/dataset-line-schema.json', import.meta.url), 'utf8'))

describe('prepareSchema', () => {
  it('translates vjsf v2 keywords so compile accepts the result', async () => {
    const prepared = await prepareSchema(fetched)
    assert.equal('x-fromUrl' in prepared.properties.departement, false)
    assert.ok(prepared.properties.departement.layout.getItems, 'x-fromUrl should become layout.getItems')
    assert.doesNotThrow(() => compile(prepared))
  })

  it('normalizes a string layout into a component object', async () => {
    const prepared = await prepareSchema(fetched)
    assert.deepEqual(prepared.properties.note.layout, { comp: 'textarea' })
  })

  it('hides attachment columns, which an agent has no file for', async () => {
    const prepared = await prepareSchema(fetched)
    assert.equal(prepared.properties.piece_jointe.layout.comp, 'none')
  })

  it('hides extension columns, which the API computes', async () => {
    const prepared = await prepareSchema(fetched)
    assert.equal(prepared.properties.population_calculee.layout.comp, 'none')
  })

  it('leaves editable columns alone', async () => {
    const prepared = await prepareSchema(fetched)
    assert.equal(prepared.properties.code_commune.layout?.comp, undefined)
  })

  it('does not mutate its input', async () => {
    await prepareSchema(fetched)
    assert.equal(fetched.properties.departement['x-fromUrl'], 'https://example.com/departements')
    assert.equal(fetched.properties.note.layout, 'textarea')
  })

  it('tolerates a schema with no properties', async () => {
    const prepared = await prepareSchema({ type: 'object' })
    assert.doesNotThrow(() => compile(prepared))
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- test/editor-prepare-schema.test.ts`
Expected: FAIL — cannot find `../src/editor/prepare-schema.ts`.

- [ ] **Step 4: Implement**

`src/editor/prepare-schema.ts`:

```ts
import type { JsonSchema } from '../types.ts'

const ATTACHMENT = 'http://schema.org/DigitalDocument'

/**
 * Turn a schema fetched from an API into one `compile` accepts, the way data-fair's own
 * line-editing form does before handing it to json-layout.
 *
 * Three steps, all of them load-bearing:
 * - `v2compat`, because dataset schemas carry vjsf-v2 keywords and compiling them raw
 *   renders pickers as plain sections while `getFieldSuggestions` refuses them;
 * - a string `layout` is shorthand for `{ comp }`, which the compat layer leaves as it
 *   found it;
 * - attachment and extension columns are hidden: an agent has no file to upload, and
 *   extension columns are computed by the API, so writing them is meaningless.
 */
export async function prepareSchema (fetched: JsonSchema): Promise<JsonSchema> {
  // Lazy: @json-layout/core is an optional peer, arriving with @json-layout/agents.
  const { v2compat } = await import('@json-layout/core/compat/v2')
  const schema: JsonSchema = v2compat(structuredClone(fetched))

  for (const property of Object.values<any>(schema.properties ?? {})) {
    if (typeof property.layout === 'string') property.layout = { comp: property.layout }
    const hide = (property['x-refersTo'] === ATTACHMENT && property.layout?.comp !== 'text-field') ||
      property['x-extension'] !== undefined
    if (hide) property.layout = { ...(property.layout ?? {}), comp: 'none' }
  }
  return schema
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/editor-prepare-schema.test.ts`
Expected: 7/7 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/editor/prepare-schema.ts test/editor-prepare-schema.test.ts test/fixtures/dataset-line-schema.json
git commit -m "feat: prepare a fetched schema the way data-fair's own form does"
```

---

### Task 4: Resolving the named operations, and the requests they make

**Files:**
- Create: `src/editor/operations.ts`
- Test: `test/editor-operations.test.ts`

**Interfaces:**
- Consumes: `AgentEditor` (Task 1), `resolveOperationById` (Task 2).
- Produces:
  ```ts
  export interface EditorOperations {
    write: ResolvedOperation
    schema?: ResolvedOperation
    read?: ResolvedOperation
    pathParamNames: string[]   // the write operation's, in declared order
  }
  export function resolveEditorOperations (op: ResolvedOperation, doc: JsonSchema): EditorOperations
  export function editorRequest (op: ResolvedOperation, pathParams: Record<string, unknown>, query: Record<string, unknown>, body: unknown, baseUrl: string): Request
  ```
  Task 5 calls both.

**Context for the implementer:** `buildRequest(op, bindings, params, baseUrl)` in `src/request.ts` already knows how to place path, query and body values. It wants `Binding[]`, which `buildInput` normally produces for the agent-facing tool. Editor calls have no agent-facing input, so `editorRequest` synthesizes trivial bindings where the tool name equals the API name.

- [ ] **Step 1: Write the failing tests**

`test/editor-operations.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOperationById } from '../src/spec.ts'
import { resolveEditorOperations, editorRequest } from '../src/editor/operations.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/datasets/{id}/schema': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'readSchema', parameters: [{ name: 'mimeType', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } }
    },
    '/datasets/{id}/lines/{lineId}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineId', in: 'path', required: true, schema: { type: 'string' } }
      ],
      get: { operationId: 'readLine', responses: { 200: { description: 'ok' } } },
      put: {
        operationId: 'updateLine',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'ok' } },
        'x-agent': { name: 'dataset_line', editor: { schemaOperation: 'readSchema', schemaParams: { mimeType: 'application/schema+json' }, readOperation: 'readLine' } }
      }
    },
    '/other/{otherId}/thing': {
      parameters: [{ name: 'otherId', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'readOther', responses: { 200: { description: 'ok' } } }
    }
  }
}

const writeOp = () => resolveOperationById(doc, 'updateLine')!

describe('resolveEditorOperations', () => {
  it('resolves both named operations and the write operation path params', () => {
    const ops = resolveEditorOperations(writeOp(), doc)
    assert.equal(ops.schema?.operationId, 'readSchema')
    assert.equal(ops.read?.operationId, 'readLine')
    assert.deepEqual(ops.pathParamNames, ['id', 'lineId'])
  })

  it('leaves schema undefined for the editor:true shorthand', () => {
    const op = writeOp()
    op.agent.editor = true
    const ops = resolveEditorOperations(op, doc)
    assert.equal(ops.schema, undefined)
    assert.equal(ops.read, undefined)
  })

  it('throws when a named operation does not exist', () => {
    const op = writeOp()
    op.agent.editor = { schemaOperation: 'noSuchOp' }
    assert.throws(() => resolveEditorOperations(op, doc), /noSuchOp/)
  })

  it('throws when a named operation needs a path param the write operation lacks', () => {
    const op = writeOp()
    op.agent.editor = { schemaOperation: 'readOther' }
    assert.throws(() => resolveEditorOperations(op, doc), /otherId/)
  })

  it('throws when the write operation has no JSON request body', () => {
    const op = resolveOperationById(doc, 'readLine')!
    op.agent.editor = true
    assert.throws(() => resolveEditorOperations(op, doc), /request body/)
  })
})

describe('editorRequest', () => {
  it('places path params and fixed query values', () => {
    const req = editorRequest(resolveOperationById(doc, 'readSchema')!, { id: 'communes' }, { mimeType: 'application/schema+json' }, undefined, 'https://api.test/v1')
    assert.equal(req.method, 'GET')
    assert.equal(new URL(req.url).pathname, '/v1/datasets/communes/schema')
    assert.equal(new URL(req.url).searchParams.get('mimeType'), 'application/schema+json')
  })

  it('sends a JSON body on the write operation', async () => {
    const req = editorRequest(writeOp(), { id: 'communes', lineId: 'abc' }, {}, { nom: 'Rennes' }, 'https://api.test/v1')
    assert.equal(req.method, 'PUT')
    assert.equal(req.headers.get('content-type'), 'application/json')
    assert.deepEqual(await req.json(), { nom: 'Rennes' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/editor-operations.test.ts`
Expected: FAIL — cannot find `../src/editor/operations.ts`.

- [ ] **Step 3: Implement**

`src/editor/operations.ts`:

```ts
import { resolveOperationById } from '../spec.ts'
import { buildRequest } from '../request.ts'
import type { Binding } from '../input.ts'
import type { AgentEditor, JsonSchema, ResolvedOperation } from '../types.ts'

export interface EditorOperations {
  write: ResolvedOperation
  schema?: ResolvedOperation
  read?: ResolvedOperation
  /** the write operation's path parameter names, in declared order */
  pathParamNames: string[]
}

function named (doc: JsonSchema, operationId: string | undefined, write: ResolvedOperation, pathParamNames: string[], role: string): ResolvedOperation | undefined {
  if (!operationId) return undefined
  const op = resolveOperationById(doc, operationId)
  if (!op) throw new Error(`${write.operationId}: editor.${role} names "${operationId}", which is not an operation in this document`)
  // Path parameters are matched by name: a named operation can only ask for values the
  // write operation's own caller supplies. Caught here rather than on the first call,
  // because it is a defect in the document, not in the request.
  for (const p of op.params) {
    if (p.in === 'path' && !pathParamNames.includes(p.name)) {
      throw new Error(`${write.operationId}: editor.${role} "${operationId}" needs path parameter "${p.name}", which ${write.operationId} does not supply`)
    }
  }
  return op
}

export function resolveEditorOperations (write: ResolvedOperation, doc: JsonSchema): EditorOperations {
  if (!write.requestBody) throw new Error(`${write.operationId}: an editor needs a JSON request body`)
  const editor: AgentEditor = write.agent.editor === true ? {} : (write.agent.editor ?? {})
  const pathParamNames = write.params.filter(p => p.in === 'path').map(p => p.name)
  return {
    write,
    schema: named(doc, editor.schemaOperation, write, pathParamNames, 'schemaOperation'),
    read: named(doc, editor.readOperation, write, pathParamNames, 'readOperation'),
    pathParamNames
  }
}

/**
 * Build a request for one of the editor's own calls. These have no agent-facing input
 * schema, so the bindings are trivial: every parameter is addressed by its API name.
 */
export function editorRequest (op: ResolvedOperation, pathParams: Record<string, unknown>, query: Record<string, unknown>, body: unknown, baseUrl: string): Request {
  const bindings: Binding[] = op.params
    .filter(p => p.in !== 'header')
    .map(p => ({ toolName: p.name, kind: p.in as 'path' | 'query', apiName: p.name, style: p.style, explode: p.explode }))
  const params: Record<string, unknown> = { ...pathParams }
  for (const [k, v] of Object.entries(query)) {
    if (!bindings.some(b => b.toolName === k)) bindings.push({ toolName: k, kind: 'query', apiName: k })
    params[k] = v
  }
  if (body !== undefined) {
    bindings.push({ toolName: '__body', kind: 'body', apiName: '__body' })
    params.__body = body
  }
  return buildRequest(op, bindings, params, baseUrl)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/editor-operations.test.ts`
Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/editor/operations.ts test/editor-operations.test.ts
git commit -m "feat: resolve the operations an editor annotation names"
```

---

### Task 5: The `SessionSpec`, and one schema closure per schema

**Files:**
- Create: `src/editor/session-spec.ts`
- Test: `test/editor-session-spec.test.ts`

**Interfaces:**
- Consumes: `EditorOperations`, `editorRequest` (Task 4), `prepareSchema` (Task 3).
- Produces:
  ```ts
  export interface EditorContext {
    doc: JsonSchema
    baseUrl: string
    fetch: typeof globalThis.fetch
    locale: string
  }
  export function createSchemaRegistry (): SchemaRegistry
  export interface SchemaRegistry { get (ops: EditorOperations, pathParams: Record<string, unknown>, ctx: EditorContext): () => Promise<unknown> }
  export function buildSessionSpec (ops: EditorOperations, pathParams: Record<string, unknown>, ctx: EditorContext, registry: SchemaRegistry): object
  ```
  Task 6 passes the returned object to `createFormSession`. It is typed `object` here so this module need not import the optional peer's types.

**Context for the implementer:** the registry is the point of this task. `resolveCompiledLayout` caches compiled layouts in a `WeakMap` keyed by **the schema function object itself** (`@json-layout/agents/src/layout-cache.js:68-79`), sub-keyed by compile options and invalidated when the function reports a new `version`. Hand each session a fresh closure and every session recompiles — two hundred line edits in one dataset become two hundred compilations of one schema. So closures are memoized by the schema *operation's* own inputs, not by the session's.

- [ ] **Step 1: Write the failing tests**

`test/editor-session-spec.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOperationById } from '../src/spec.ts'
import { resolveEditorOperations } from '../src/editor/operations.ts'
import { buildSessionSpec, createSchemaRegistry } from '../src/editor/session-spec.ts'

const doc = {
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
  paths: {
    '/datasets/{id}/schema': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      get: { operationId: 'readSchema', parameters: [{ name: 'mimeType', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } }
    },
    '/datasets/{id}/lines/{lineId}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'lineId', in: 'path', required: true, schema: { type: 'string' } }
      ],
      get: { operationId: 'readLine', responses: { 200: { description: 'ok' } } },
      put: {
        operationId: 'updateLine',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'ok' } },
        'x-agent': { name: 'dataset_line', title: { en: 'Edit a record' }, editor: { schemaOperation: 'readSchema', schemaParams: { mimeType: 'application/schema+json' }, readOperation: 'readLine' } }
      }
    }
  }
}

const LINE_SCHEMA = { type: 'object', required: [], properties: { nom: { type: 'string', title: 'Nom' } } }

function harness (overrides: Record<string, unknown> = {}) {
  const calls: { method: string, url: string, body?: string }[] = []
  const fetchFn = (async (input: Request) => {
    calls.push({ method: input.method, url: input.url, body: input.body ? await input.clone().text() : undefined })
    if (input.url.includes('/schema')) return new Response(JSON.stringify(overrides.schema ?? LINE_SCHEMA), { headers: { 'content-type': 'application/json' } })
    if (input.method === 'GET') return new Response(JSON.stringify({ nom: 'Rennes' }), { headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  const ctx = { doc, baseUrl: 'https://api.test/v1', fetch: fetchFn, locale: 'en' }
  const ops = resolveEditorOperations(resolveOperationById(doc, 'updateLine')!, doc)
  return { calls, ctx, ops, registry: createSchemaRegistry() }
}

describe('buildSessionSpec', () => {
  it('loads the document through readOperation', async () => {
    const { calls, ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    assert.deepEqual(await spec.load(), { data: { nom: 'Rennes' }, version: undefined })
    assert.equal(new URL(calls[0].url).pathname, '/v1/datasets/communes/lines/abc')
  })

  it('makes no request when there is no readOperation — a create', async () => {
    const { calls, ctx, registry } = harness()
    const op = resolveOperationById(doc, 'updateLine')!
    op.agent.editor = { schemaOperation: 'readSchema' }
    const ops = resolveEditorOperations(op, doc)
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    assert.deepEqual(await spec.load(), { data: {}, version: undefined })
    assert.equal(calls.length, 0)
  })

  it('fetches the schema with schemaParams applied and prepares it', async () => {
    const { calls, ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    const { schema, version } = await spec.schema()
    assert.equal(schema.properties.nom.type, 'string')
    assert.equal(typeof version, 'string')
    const url = new URL(calls[0].url)
    assert.equal(url.pathname, '/v1/datasets/communes/schema')
    assert.equal(url.searchParams.get('mimeType'), 'application/schema+json')
  })

  it('never sends an arrays parameter', async () => {
    const { calls, ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    await spec.schema()
    assert.equal(new URL(calls[0].url).searchParams.has('arrays'), false)
  })

  it('hands two sessions over the same dataset the same schema function', () => {
    const { ctx, ops, registry } = harness()
    const a: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    const b: any = buildSessionSpec(ops, { id: 'communes', lineId: 'zzz' }, ctx, registry)
    assert.equal(a.schema, b.schema, 'same dataset must share one closure, or the layout recompiles per line')
  })

  it('hands two datasets different schema functions', () => {
    const { ctx, ops, registry } = harness()
    const a: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    const b: any = buildSessionSpec(ops, { id: 'autre', lineId: 'abc' }, ctx, registry)
    assert.notEqual(a.schema, b.schema)
  })

  it('reports a version that changes when the schema changes', async () => {
    const one = harness()
    const two = harness({ schema: { type: 'object', properties: { autre: { type: 'string' } } } })
    const specA: any = buildSessionSpec(one.ops, { id: 'communes', lineId: 'abc' }, one.ctx, one.registry)
    const specB: any = buildSessionSpec(two.ops, { id: 'communes', lineId: 'abc' }, two.ctx, two.registry)
    assert.notEqual((await specA.schema()).version, (await specB.schema()).version)
  })

  it('saves the whole document through the write operation', async () => {
    const { calls, ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    await spec.save({ nom: 'Brest' }, {})
    const put = calls.find(c => c.method === 'PUT')!
    assert.equal(new URL(put.url).pathname, '/v1/datasets/communes/lines/abc')
    assert.equal(put.body, JSON.stringify({ nom: 'Brest' }))
  })

  it('reports an API error rather than swallowing it', async () => {
    const ctx = { doc, baseUrl: 'https://api.test/v1', locale: 'en', fetch: (async () => new Response('nope', { status: 403 })) as unknown as typeof globalThis.fetch }
    const ops = resolveEditorOperations(resolveOperationById(doc, 'updateLine')!, doc)
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, createSchemaRegistry())
    await assert.rejects(() => spec.save({ nom: 'Brest' }, {}), /403/)
  })

  it('carries the localized title', () => {
    const { ctx, ops, registry } = harness()
    const spec: any = buildSessionSpec(ops, { id: 'communes', lineId: 'abc' }, ctx, registry)
    assert.equal(spec.title, 'Edit a record')
    assert.equal(spec.prefixName, 'dataset_line_')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/editor-session-spec.test.ts`
Expected: FAIL — cannot find `../src/editor/session-spec.ts`.

- [ ] **Step 3: Implement**

`src/editor/session-spec.ts`:

```ts
import { createHash } from 'node:crypto'
import { localize } from '../localize.ts'
import { prepareSchema } from './prepare-schema.ts'
import { editorRequest, type EditorOperations } from './operations.ts'
import type { AgentEditor, JsonSchema } from '../types.ts'

export interface EditorContext {
  doc: JsonSchema
  baseUrl: string
  fetch: typeof globalThis.fetch
  locale: string
}

export interface SchemaRegistry {
  get (ops: EditorOperations, pathParams: Record<string, unknown>, ctx: EditorContext): () => Promise<unknown>
}

const editorOf = (ops: EditorOperations): AgentEditor => ops.write.agent.editor === true ? {} : (ops.write.agent.editor ?? {})

async function json (ctx: EditorContext, request: Request): Promise<{ text: string, value: unknown }> {
  const response = await ctx.fetch(request)
  const text = await response.text()
  if (!response.ok) throw new Error(`${request.method} ${request.url} failed: ${response.status} ${text.slice(0, 200)}`)
  return { text, value: text ? JSON.parse(text) : undefined }
}

/**
 * One schema closure per distinct schema, shared by every session that needs it.
 *
 * `resolveCompiledLayout` caches compiled layouts against the schema *function object*,
 * so a fresh closure per session means a fresh compilation per session. Keyed by what the
 * schema request actually depends on — the operation, its own path parameters, and the
 * fixed query — which for dataset lines is the dataset, not the line.
 */
export function createSchemaRegistry (): SchemaRegistry {
  const closures = new Map<string, () => Promise<unknown>>()
  return {
    get (ops, pathParams, ctx) {
      const editor = editorOf(ops)
      if (!ops.schema) {
        // No schemaOperation: the declared request body is the schema, constant for the
        // life of the process, so one closure for the operation is the same rule.
        const key = `declared:${ops.write.operationId}`
        let closure = closures.get(key)
        if (!closure) {
          const declared = ops.write.requestBody!.schema
          closure = async () => ({ schema: await prepareSchema(declared), version: ops.write.operationId })
          closures.set(key, closure)
        }
        return closure
      }
      const own: Record<string, unknown> = {}
      for (const p of ops.schema.params) if (p.in === 'path') own[p.name] = pathParams[p.name]
      const key = `${ops.schema.operationId}:${JSON.stringify(own)}:${JSON.stringify(editor.schemaParams ?? {})}`
      let closure = closures.get(key)
      if (!closure) {
        closure = async () => {
          const request = editorRequest(ops.schema!, own, editor.schemaParams ?? {}, undefined, ctx.baseUrl)
          const { text, value } = await json(ctx, request)
          // The body's hash, because the response carries no validator header and the
          // dataset's updatedAt is a second request away. It only has to change when the
          // schema does.
          return { schema: await prepareSchema(value as JsonSchema), version: createHash('sha1').update(text).digest('hex') }
        }
        closures.set(key, closure)
      }
      return closure
    }
  }
}

export function buildSessionSpec (ops: EditorOperations, pathParams: Record<string, unknown>, ctx: EditorContext, registry: SchemaRegistry): object {
  const read = ops.read
  return {
    title: localize(ops.write.agent.title, ctx.locale) ?? ops.write.operationId,
    prefixName: `${ops.write.toolName}_`,
    schema: registry.get(ops, pathParams, ctx),
    load: async () => {
      if (!read) return { data: {}, version: undefined }
      const own: Record<string, unknown> = {}
      for (const p of read.params) if (p.in === 'path') own[p.name] = pathParams[p.name]
      const { value } = await json(ctx, editorRequest(read, own, {}, undefined, ctx.baseUrl))
      return { data: value, version: undefined }
    },
    // `context.base` goes unused: both target operations replace the whole document, so
    // there is nothing to diff against.
    save: async (data: unknown) => {
      const own: Record<string, unknown> = {}
      for (const p of ops.write.params) if (p.in === 'path') own[p.name] = pathParams[p.name]
      await json(ctx, editorRequest(ops.write, own, {}, data, ctx.baseUrl))
      return { version: undefined }
    },
    options: { fetch: ctx.fetch, fetchBaseURL: ctx.baseUrl }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/editor-session-spec.test.ts`
Expected: 11/11 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/editor/session-spec.ts test/editor-session-spec.test.ts
git commit -m "feat: build a SessionSpec, with one schema closure per schema"
```

---

### Task 6: The tool group, and wiring it into `load`

**Files:**
- Create: `src/editor/bridge.ts`
- Create: `src/editor/index.ts`
- Modify: `src/spec.ts` (remove the phase-1 `editor` throw)
- Modify: `src/load.ts:123-156`
- Modify: `package.json`
- Test: `test/editor-bridge.test.ts`, `test/editor-group.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: `export async function buildEditorTools (op: ResolvedOperation, ctx: EditorContext): Promise<Tool[]>`, called by `load`.

**Context for the implementer:** `session.getTools()` throws while the session is closed, but `load()` must publish descriptors before any dataset is named and without making an HTTP call. Hence the bootstrap session: one session over a `load` returning `{}` and a `schema` returning a literal empty object schema, opened, its tools read for names, descriptions and input schemas, then discarded. The descriptions then come from the package rather than being retyped here — they are the text an agent reads to decide what to call.

The package's own tools already catch their errors and return MCP-shaped `{ content: [{ type: 'text', text }], isError }`. What can still throw is `getOrCreate` + `open()` — a failed schema fetch, a failed load — so the bridge wraps those.

- [ ] **Step 1: Write the failing bridge test**

`test/editor-bridge.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bridgeTool, toToolResult } from '../src/editor/bridge.ts'

describe('toToolResult', () => {
  it('joins text content', () => {
    assert.deepEqual(toToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), { text: 'a\nb', isError: undefined })
  })

  it('carries isError through', () => {
    assert.deepEqual(toToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true }), { text: 'boom', isError: true })
  })

  it('survives a result with no content', () => {
    assert.deepEqual(toToolResult({}), { text: '', isError: undefined })
  })
})

describe('bridgeTool', () => {
  const formTool = {
    name: 'dataset_line_setFieldValue',
    description: 'Set one field',
    inputSchema: { type: 'object', properties: { pointer: { type: 'string' } }, required: ['pointer'] },
    execute: async (args: any) => ({ content: [{ type: 'text', text: `got ${JSON.stringify(args)}` }] })
  }
  const pathParams = [
    { name: 'id', schema: { type: 'string', title: 'Dataset' }, required: true },
    { name: 'lineId', schema: { type: 'string' }, required: true }
  ]

  it('adds the path parameters to the input schema and keeps the original required', () => {
    const tool = bridgeTool(formTool, pathParams as any, async () => formTool)
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ['id', 'lineId', 'pointer'])
    assert.deepEqual(tool.inputSchema.required, ['id', 'lineId', 'pointer'])
  })

  it('passes only the non-path arguments to the session tool', async () => {
    const tool = bridgeTool(formTool, pathParams as any, async () => formTool)
    const result = await tool.execute({ id: 'communes', lineId: 'abc', pointer: '/nom' })
    assert.equal(result.text, 'got {"pointer":"/nom"}')
  })

  it('turns a resolver failure into an error result rather than a throw', async () => {
    const tool = bridgeTool(formTool, pathParams as any, async () => { throw new Error('schema fetch failed: 404') })
    const result = await tool.execute({ id: 'communes', lineId: 'abc', pointer: '/nom' })
    assert.equal(result.isError, true)
    assert.match(result.text, /schema fetch failed: 404/)
  })

  it('reports a missing path parameter without calling the resolver', async () => {
    let called = false
    const tool = bridgeTool(formTool, pathParams as any, async () => { called = true; return formTool })
    const result = await tool.execute({ pointer: '/nom' })
    assert.equal(result.isError, true)
    assert.match(result.text, /id/)
    assert.equal(called, false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- test/editor-bridge.test.ts`
Expected: FAIL — cannot find `../src/editor/bridge.ts`.

- [ ] **Step 3: Implement the bridge**

`src/editor/bridge.ts`:

```ts
import type { JsonSchema, ResolvedParam, Tool, ToolResult } from '../types.ts'

/** The shape @json-layout/agents hands us; typed here so this module need not import the optional peer. */
export interface FormTool {
  name: string
  description: string
  inputSchema?: JsonSchema
  execute (args?: Record<string, unknown>): Promise<{ content?: { type: string, text?: string }[], isError?: boolean }>
}

export function toToolResult (result: { content?: { type: string, text?: string }[], isError?: boolean }): ToolResult {
  const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
  return { text, isError: result.isError }
}

/**
 * One package tool, addressed by resource.
 *
 * The package's tools have fixed input schemas and no notion of which record is being
 * edited, so the path parameters are added here and stripped back off before delegating.
 * `resolve` opens or resumes the session for those parameters.
 */
export function bridgeTool (descriptor: FormTool, pathParams: ResolvedParam[], resolve: (pathValues: Record<string, unknown>) => Promise<FormTool>): Tool {
  const properties: Record<string, unknown> = {}
  for (const p of pathParams) properties[p.name] = p.schema
  for (const [k, v] of Object.entries(descriptor.inputSchema?.properties ?? {})) properties[k] = v

  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: {
      type: 'object',
      properties,
      required: [...pathParams.map(p => p.name), ...(descriptor.inputSchema?.required ?? [])]
    },
    annotations: { readOnlyHint: false },
    async execute (params: Record<string, unknown>): Promise<ToolResult> {
      const pathValues: Record<string, unknown> = {}
      for (const p of pathParams) {
        const value = params?.[p.name]
        if (value === undefined || value === null) return { isError: true, text: `Missing required parameter "${p.name}".` }
        pathValues[p.name] = value
      }
      const rest = { ...params }
      for (const p of pathParams) delete rest[p.name]
      try {
        const tool = await resolve(pathValues)
        return toToolResult(await tool.execute(rest))
      } catch (err) {
        // A failed open — schema fetch, document load, a compile error — is a datum the
        // agent can act on, not a crash. Same contract as every other tool here.
        return { isError: true, text: `Error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }
}
```

- [ ] **Step 4: Run the bridge test to verify it passes**

Run: `npm test -- test/editor-bridge.test.ts`
Expected: 7/7 PASS.

- [ ] **Step 5: Write the failing group test**

`test/editor-group.test.ts` — uses the same `doc` and stub `fetch` as `test/editor-session-spec.test.ts`; copy them into this file rather than exporting them from a test module:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { load } from '../src/load.ts'

// ...the same `doc` literal as test/editor-session-spec.test.ts, plus `profiles: ['write']`
// on the updateLine x-agent, and a root x-agent declaring the `write` profile.

describe('editor tool group', () => {
  it('produces eight tools named after the operation', async () => {
    const { tools } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.deepEqual(tools.map(t => t.name).sort(), [
      'dataset_line_describeState', 'dataset_line_editArray', 'dataset_line_getData',
      'dataset_line_getFieldSuggestions', 'dataset_line_reloadForm', 'dataset_line_saveForm',
      'dataset_line_setData', 'dataset_line_setFieldValue'
    ].sort())
  })

  it('makes no HTTP request while building the tools', async () => {
    calls.length = 0
    await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.equal(calls.length, 0, 'descriptors must be published without touching the API')
  })

  it('every tool takes the write operation path parameters', async () => {
    const { tools } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    for (const tool of tools) {
      assert.equal(tool.inputSchema.properties.id !== undefined, true, `${tool.name} should take id`)
      assert.equal(tool.inputSchema.properties.lineId !== undefined, true, `${tool.name} should take lineId`)
    }
  })

  it('opens a session on first call and describes the fetched schema', async () => {
    const { tools } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const describe = tools.find(t => t.name === 'dataset_line_describeState')!
    const result = await describe.execute({ id: 'communes', lineId: 'abc' })
    assert.equal(result.isError, undefined)
    assert.match(result.text, /Nom/)
  })

  it('resumes the same session for the same record', async () => {
    const { tools } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    const set = tools.find(t => t.name === 'dataset_line_setFieldValue')!
    const get = tools.find(t => t.name === 'dataset_line_getData')!
    await set.execute({ id: 'communes', lineId: 'abc', pointer: '/nom', value: 'Brest' })
    const result = await get.execute({ id: 'communes', lineId: 'abc' })
    assert.match(result.text, /Brest/)
  })

  it('appends the group guide to the instructions', async () => {
    const { instructions } = await load(doc, { profile: 'write', fetch: fetchFn, baseUrl: 'https://api.test/v1' })
    assert.match(instructions, /dataset_line/)
  })
})
```

If `setFieldValue`'s argument names differ from `pointer`/`value`, read them off `tools.find(...)!.inputSchema` in the test and use the real ones — the package owns that contract, not this plan.

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- test/editor-group.test.ts`
Expected: FAIL — `"editor" is not implemented in phase 1`.

- [ ] **Step 7: Implement the group**

`src/editor/index.ts`:

```ts
import { resolveEditorOperations } from './operations.ts'
import { buildSessionSpec, createSchemaRegistry, type EditorContext } from './session-spec.ts'
import { bridgeTool, type FormTool } from './bridge.ts'
import type { ResolvedOperation, Tool } from '../types.ts'

export type { EditorContext } from './session-spec.ts'

const STUB_SPEC = {
  title: 'form',
  load: () => ({}),
  schema: () => ({ type: 'object', properties: {} })
}

/**
 * The eight tools of one editor group.
 *
 * Descriptors come from a throwaway session over a literal stub: `getTools()` throws
 * while a session is closed, but `load()` must publish names, descriptions and input
 * schemas before any record is named and without touching the API. Taking them from the
 * package rather than retyping them keeps the text an agent reads in one place.
 */
export async function buildEditorTools (op: ResolvedOperation, ctx: EditorContext): Promise<Tool[]> {
  const { createFormSession, createSessionStore } = await import('@json-layout/agents')
  const ops = resolveEditorOperations(op, ctx.doc)
  const registry = createSchemaRegistry()
  const store = createSessionStore<any>()
  const pathParams = op.params.filter(p => p.in === 'path')

  const bootstrap = createFormSession({ ...STUB_SPEC, prefixName: `${op.toolName}_` } as any)
  await bootstrap.open()
  const descriptors: FormTool[] = bootstrap.getTools()
  bootstrap.close()

  return descriptors.map(descriptor => bridgeTool(descriptor, pathParams, async (pathValues) => {
    const key = `${op.toolName}:${pathParams.map(p => String(pathValues[p.name])).join(':')}`
    const session = await store.getOrCreate(key, async () => {
      const created = createFormSession(buildSessionSpec(ops, pathValues, ctx, registry) as any)
      await created.open()
      return created
    })
    const tool = session.getTools().find((t: FormTool) => t.name === descriptor.name)
    if (!tool) throw new Error(`the session has no tool named "${descriptor.name}"`)
    return tool
  }))
}
```

In `src/spec.ts`, delete the `if (agent.editor) throw ...` guard and the comment above it.

In `src/load.ts`, replace the `built`/`tools` assembly (lines 142-155) with:

```ts
  const editorOps = ops.filter(op => op.agent.editor)
  const plainOps = ops.filter(op => !op.agent.editor)
  const built = plainOps.map(op => makeTool(op, o))

  if (o.lint !== 'off') {
    // ...unchanged
  }

  const tools: Tool[] = built.map(({ authoredDescriptions, ...tool }) => tool)
  for (const op of editorOps) {
    tools.push(...await buildEditorTools(op, { doc, baseUrl, fetch: fetchFn, locale: o.locale }))
  }
  return { profile, instructions: buildInstructions(doc, profile, ops, o.locale), tools }
```

with `import { buildEditorTools } from './editor/index.ts'` at the top. `buildInstructions` already receives every operation including the editor ones, so the group appears in the instructions through the existing path; if it does not, add a section naming the group's tools.

In `package.json`, add:

```json
  "peerDependencies": { "@json-layout/agents": "^0.1.0" },
  "peerDependenciesMeta": { "@json-layout/agents": { "optional": true } }
```

and `"@json-layout/agents": "^0.1.0"` to `devDependencies`, then `npm install`.

- [ ] **Step 8: Run the whole suite**

Run: `npm run quality`
Expected: lint clean, `tsc` clean, every test PASS — including the phase-1 tests that assert `editor` used to throw. **If one of those exists, it is now wrong**: delete it and say so in your report.

- [ ] **Step 9: Commit**

```bash
git add src/editor/ src/spec.ts src/load.ts package.json package-lock.json test/editor-bridge.test.ts test/editor-group.test.ts
git commit -m "feat: eight json-layout editor tools from one annotated operation"
```

---

### Task 7: The live check

**Files:**
- Create: `docs/superpowers/notes/2026-09-21-editor-live-check.md`
- Create: `scripts/editor-live-check.ts`

**Interfaces:**
- Consumes: `load` with an editor-annotated document.
- Produces: a committed report. No library code.

**Context for the implementer:** every test so far uses a stub `fetch`. This is the step that caught the `agg_size` bug in phase 1, which no unit test saw: the schema data-fair actually returns, compiled by the layer we actually ship. Writing to `opendata.koumoul.com` needs a token this harness does not have, so **a 401/403 on save is the expected outcome** — report it as such. Everything up to the save must work.

- [ ] **Step 1: Write the script**

`scripts/editor-live-check.ts` — annotate the frozen document in memory, then drive the group:

```ts
import { load } from '../src/load.ts'
import { readFile } from 'node:fs/promises'

const doc = JSON.parse(await readFile(new URL('../test/fixtures/data-fair-root.json', import.meta.url), 'utf8'))
const dataset = process.argv[2] ?? '<a REST dataset id from the probe>'
const lineId = process.argv[3]

doc['x-agent'] = { ...(doc['x-agent'] ?? {}), profiles: { ...(doc['x-agent']?.profiles ?? {}), write: { description: 'write' } } }
const put = doc.paths['/datasets/{id}/lines/{lineId}'].put
put['x-agent'] = {
  profiles: ['write'],
  name: 'dataset_line',
  title: { en: 'Edit a dataset record' },
  editor: {
    schemaOperation: 'readSchema',
    schemaParams: { mimeType: 'application/schema+json', extension: 'true' },
    readOperation: 'readLine'
  }
}

const { tools, instructions } = await load(doc, { profile: 'write' })
console.log(`tools: ${tools.map(t => t.name).join(', ')}`)
console.log(`definition bytes: ${JSON.stringify(tools).length}`)
console.log(`instructions bytes: ${instructions.length}`)

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await tools.find(t => t.name === name)!.execute(args)
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===\n${result.isError ? 'ERROR: ' : ''}${result.text.slice(0, 1500)}`)
  return result
}

await call('dataset_line_describeState', { id: dataset, lineId })
await call('dataset_line_getData', { id: dataset, lineId })
await call('dataset_line_saveForm', { id: dataset, lineId })
```

- [ ] **Step 2: Pick a live target**

Run this to find a REST dataset with a line id:

```bash
node -e '
const B="https://opendata.koumoul.com/data-fair/api/v1"
const l = await (await fetch(B+"/datasets?size=100&select=id,isRest,count")).json()
const d = l.results.find(x => x.isRest && x.count > 0)
const line = (await (await fetch(`${B}/datasets/${d.id}/lines?size=1`)).json()).results[0]
console.log(d.id, line._id)
'
```

- [ ] **Step 3: Run the check**

Run: `node scripts/editor-live-check.ts <dataset> <lineId>`
Expected: `describeState` renders the dataset's real columns; `getData` shows the fetched line; `saveForm` reports the API's 401/403 as an error result rather than throwing.

- [ ] **Step 4: Write the report**

`docs/superpowers/notes/2026-09-21-editor-live-check.md` — the dataset and line used, the eight tool names, definition and instruction byte counts, the first 40 lines of `describeState`, and every surprise. A surprise with no explanation is still a finding: write it down.

- [ ] **Step 5: Commit**

```bash
git add scripts/editor-live-check.ts docs/superpowers/notes/2026-09-21-editor-live-check.md
git commit -m "test: drive the editor group against the live API"
```

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| `editor.{schemaOperation, schemaParams, readOperation}` vocabulary, `editor: true` preserved | 1 |
| Named operations resolved though they carry no `x-agent` | 2 |
| `v2compat` + string-`layout` normalization | 3 |
| Attachment and `x-extension` columns hidden | 3 |
| Path parameters matched by name; load-time failure | 4 |
| No JSON request body → load-time failure | 4 |
| `load` / `save` / `schema` / `options` / `title` / `prefixName` mapping | 5 |
| One schema closure per schema, not per session | 5 |
| Version is a hash of the response body | 5 |
| `schemaParams` never carries `arrays` | 5 (asserted), Global Constraints |
| Session key is the write operation plus its path parameters | 6 |
| Descriptor bootstrapping with no HTTP | 6 |
| Errors become `isError` results, never throws | 6 |
| Eight tools, prefixed, profile-gated | 6 |
| `@json-layout/agents` optional and lazily imported | 6, Global Constraints |
| Live end-to-end check, run by hand and reported | 7 |

**Not covered, deliberately:** the primary-key `readOnly` rule (the spec defers it to an upstream request), `includeSubAgent`, `patchLine`, precompiled layouts, and `createLine` — the create path falls out of `readOperation` being absent, which Task 5 tests, but no annotation for it ships here. Add it once Task 7 reports.

**Type consistency:** `EditorOperations`, `EditorContext`, `SchemaRegistry`, `FormTool` and `buildEditorTools` are each defined once and used under the same name and shape in every later task. `buildSessionSpec` returns `object` so no module outside `src/editor/index.ts` imports the optional peer's types.
