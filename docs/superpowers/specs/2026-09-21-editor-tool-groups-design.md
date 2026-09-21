# Editor tool groups — design

*2026-09-21. Experimental; not aiming for production yet.*
*Second rewrite. The first was written from scratch before `@json-layout/agents` was
found; this one moves the target from dataset PATCH to dataset lines after a probe
disqualified the former.*

## Why

Phase 1 produced read tools from annotations; phase 2 showed they hold up against
hand-written ones. Writing is the half neither covered.

For a body whose difficulty is only its **size**, the answer is already built: `body:
compact` renders the schema as a listing and validates the real thing at execution, taking
data-fair's dataset write tool from 28,033 characters to 2,840.

This document is for the case `body: compact` structurally cannot reach: **a body whose
schema is not in the OpenAPI document at all**. It is decided at runtime, per resource.

## The target: dataset lines

`POST /datasets/{id}/lines` (`createLine`) and `PUT /datasets/{id}/lines/{lineId}`
(`updateLine`) write one record into a REST dataset. What their body accepts depends
entirely on which dataset `{id}` names.

The document cannot say so. Its declared body for both is the synthetic seven-column
sample — `name, description, category, value, siret, image, document` — that finding A3
of the readiness notes already condemns. It is fiction for every real dataset.

The real schema is one GET away:

```
GET /datasets/communes-de-france/schema?mimeType=application/schema+json
→ {"type":"object","required":[],"properties":{"code_commune":{…},"nom_commune":{…}}}
  4,992 characters, a genuine JSON Schema
```

That is the whole reason a session exists here. `body: compact` renders a schema the
document holds; there is no such schema to render. Fetching one at call time and rendering
it into a single tool description is not possible either — tool descriptions are published
once, before any dataset is named. A schema that arrives after the tool list has shipped
needs somewhere to live between calls, and that is a session.

**This target was chosen over dataset PATCH**, which the first draft assumed. The probe
that killed it is recorded as finding A6: a `communes-de-france` document fetched live is
already invalid against `datasetPatch` before any edit — three errors on `rest`. An editor
whose first act is to report three errors the agent did not cause is worse than no editor.
Lines have no such problem, and `updateLine` is a **PUT**, so the session submits the whole
document and needs no diff against `SaveContext.base`.

Two further shapes of the same need exist in the product, and the design should not
foreclose them:

| Shape | Where the schema comes from | Covered here |
|---|---|---|
| Dataset lines | runtime `GET /datasets/{id}/schema` | yes — this document |
| Application config | runtime GET on the application's config schema | same mechanism, not built yet |
| Portals page / portal config | a layout **precompiled at build time**, imported per locale (`portals/ui/src/composables/use-page-config-webmcp.ts`) | no — see Non-goals |

## What data-fair's own form already does

`ui/src/components/dataset/form/dataset-edit-line-form.vue` builds the human line-editing
form from exactly this schema, with json-layout underneath. It is the best available
specification of this task, and it is not a bare `compile()` call.

**The schema compiles — through the vjsf v2 compatibility layer.** Line 73 is
`v2compat(jsonSchema)` before anything else, and line 80 then normalizes a string `layout`
into `{ comp }`. Dataset schemas carry v2-era keywords (`x-fromUrl` and friends), which is
the same symptom the abandoned PATCH probe hit as `failed to normalize layout, use default
component`. **The adapter must apply the same layer**; treating the fetched schema as
compile-ready would reproduce that failure per dataset rather than per document.

That layer is a packaging problem, not a technical one. It is pure JavaScript over `ajv`,
`@json-layout/vocabulary` and json-layout's own `resolveLocaleRefs` — no Vue, no component
code — but it ships only as `@koumoul/vjsf/compat/v2`, from a Vue component library a
server-side tool has no business depending on. json-layout already vendored a copy into
`core/webmcp-eval/cases/vjsf-compat-v2.js` for the same reason, with a header explaining
that CI has no sibling checkout to import from. That is two consumers outside vjsf wanting
it. **Recommendation: move it to `@json-layout/vocabulary`, or export it as
`@json-layout/core/compat/v2`,** and let vjsf re-export. Until then the adapter vendors a
third copy, which is the wrong answer held deliberately.

**The form also edits the schema before compiling it**, and each edit is a question for us:

| What the form does | Line | Does the editor want it? |
|---|---|---|
| `readOnly` on the primary key columns | 83-85 | **Wanted on update** — rewriting a primary key is a different record, not an edit — but see below. |
| `readOnly` on caller-named `readonlyCols` | 80-82 | No — that is a per-embed prop, not a property of the API. |
| `layout.comp = 'none'` on attachment (`DigitalDocument`) columns | 91-94 | **Yes.** An attachment is a file upload; an agent has no file to give. |
| `layout.comp = 'none'` on `x-extension` columns | 95-98 | **Yes.** Extension columns are computed by data-fair; writing them is meaningless. |
| `delete _owner` / `_ownerName` on own-lines routes | 75-77 | Only if we annotate `createOwnLine` / `updateOwnLine`, which this phase does not. |

Two of those — attachments and extension columns — are readable from the fetched schema
itself, which carries `x-refersTo` and `x-extension` on each property. They cost nothing
and belong in the adapter rather than in an annotation, since nothing about them varies
per API.

**The primary key does not.** `primaryKey` lives on the dataset document, not in the
schema response, so the form gets it from a `restDataset` it already holds and the editor
would need a third GET per session. Three ways out, in preference order: ask for
`readOnly: true` on primary-key properties in the `application/schema+json` response,
where it belongs and where it would also fix data-fair's own form doing this by hand; or
let `editor` name a third operation for the parent resource; or ship without it and let
the save fail. The first is a readiness item to raise once A5 and A7 are on the table.

## What already exists

`@json-layout/agents` is the server-side half of this feature, and it is nearly all of it:

| Concern | Where it lives |
|---|---|
| Session lifetime, sliding TTL, eviction, concurrent-call de-duplication | `SessionStore` (`getOrCreate` shares one factory run per key) |
| Open, reload, save; status machine (`closed`/`opening`/`ready`/`stale`/`saving`/`error`) | `FormSession` |
| The save gate | `save()` refuses when `!valid` unless `allowInvalid` |
| In-flight save protection | `save()` rejects a second save while one is running |
| Optimistic concurrency | `SaveContext { version, base }`, `unwrapEnvelope` |
| Compiled-layout reuse across sessions | `resolveCompiledLayout` / `clearLayoutCache` |
| Tool surface | `getTools()` — core's six plus `saveForm` and `reloadForm` |
| Flat vs sub-agent | `includeSubAgent`, `includeFillFormSkill` flags |
| Tool prefixing | `prefixName` |

**What is left for us is one adapter**: turn an annotated OpenAPI operation into a
`SessionSpec`, and give the agent a way to say which resource it is editing.

## The annotation

`editor` names up to two *other* operations by `operationId`:

```yaml
# PUT /datasets/{id}/lines/{lineId}
x-agent:
  profiles: [write]
  name: dataset_line
  title: { en: Edit a dataset record, fr: Éditer un enregistrement }
  editor:
    schemaOperation: readSchema
    schemaParams: { mimeType: application/schema+json, extension: 'true', arrays: true }
    readOperation: readLine
```

```yaml
# POST /datasets/{id}/lines
x-agent:
  profiles: [write]
  name: dataset_new_line
  title: { en: Add a dataset record, fr: Ajouter un enregistrement }
  editor:
    schemaOperation: readSchema
    schemaParams: { mimeType: application/schema+json, extension: 'true', arrays: true }
    # no readOperation — nothing to load
```

- **`schemaOperation`** — the operation whose *response body* is the JSON Schema for this
  operation's request body. Absent means the schema is the one the document already
  declares for this request body, which is what the existing `editor: true` shorthand
  means and what a layout-annotated in-document schema needs. The dataset-line target
  always names one.
- **`schemaParams`** — fixed values for that operation's parameters. Required in practice
  here, because `readSchema` returns a JSON Schema only under one `mimeType` value and the
  document does not say so (A5). The values above are the ones data-fair's own form sends
  (`dataset-store.ts:61`), three of which the document does not declare either (A7). Once
  A5 lands as agreed, `mimeType` drops out — the runtime sets `Accept` from the declared
  response media types already.
- **`readOperation`** — the operation that loads the current document. Absent means a
  create: `load` returns `{}` with no HTTP call.

Path parameters are matched **by name** between the three operations. `readSchema` takes
`id`; `updateLine` takes `id` and `lineId`; `readLine` takes both. `load` fails if a named
operation has a path parameter the write operation does not supply — a document error we
want at load time, not at call time.

**Known divergence.** `createLine`'s declared body carries an `_action` enum
(`create`/`delete`/`update`/`createOrUpdate`/`patch`) that the fetched `/schema` response
does not. The editor drops it; a POST with no `_action` creates. An agent needing the other
verbs uses the one-shot tools, not the editor.

## Two keys, and why they are different

Conflating these costs one schema compilation per line edited.

**Session key** — which form is open. Derived from the write operation's name and *all* its
path parameters: `updateLine:communes-de-france:abc123`. One session per line. This is the
`SessionStore` key, and re-naming the same line resumes rather than reloads.

**Schema-function identity** — which layout is compiled. `resolveCompiledLayout` caches in
a `WeakMap` keyed by **the `spec.schema` function object itself**, sub-keyed by compile
options, and invalidated when that function reports a new `version`. A fresh closure per
session means a fresh compilation per session.

So the adapter keeps a second map, `Map<schemaKey, schemaFn>`, keyed by the *schema
operation's* parameters only — `readSchema:communes-de-france` — and hands every session
over that dataset the **same closure**. Editing two hundred lines of one dataset then
compiles once. An operation with no `schemaOperation` keys on its own name and gets one
closure for the life of the process, which is the same rule with a constant schema.

The closure returns the `{ schema, version }` envelope `unwrapEnvelope` recognises. The
version is what invalidates the compilation when a dataset's columns change: a hash of the
response body, since the response carries no validator header today (A7) and the
`updatedAt` the UI versions by is not reachable without a second GET. That costs one 5 KB
GET per session open and one compilation per distinct schema, which is the right trade —
the compilation is the expensive half.

## Mapping an operation to a `SessionSpec`

```
load()         -> readOperation, or () => ({}) when absent, returning { data, version }
save(data, ctx)-> the annotated write operation with `data` as the JSON body
schema()       -> schemaOperation + schemaParams, returning { schema, version };
                  the declared request body schema, as a literal, when neither is set
options        -> { fetch, fetchBaseURL } — the caller's credentials, as everywhere else
title          -> the operation's x-agent title, localized
prefixName     -> the operation's x-agent name plus '_'
```

`ctx.base` goes unused: `updateLine` is a PUT and `createLine` a POST, so both send the
whole document. `ctx.version` is forwarded as `If-Match` when `load` reported one.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Resource selection | Every editor tool takes the write operation's path parameters | No hidden "current form". Two lines, or two datasets, can be edited in one session without a mode. |
| Create-session identity | `createLine:{id}` — no line id exists yet | One draft per dataset at a time. A second "add a record" to the same dataset resumes the first draft, which is the behaviour a draft should have; `reloadForm` discards it. |
| Validity gate | `FormSession`'s own, `allowInvalid` left at its default | It already exists and reports the errors; a second gate would only disagree with the first. |
| Descriptor bootstrapping | Open a throwaway session over a stub `load` and a stub `schema` at `load()` time | Tool descriptions come from the package rather than being re-typed here, and it costs no HTTP. |
| Tool surface | Flat, profile-gated | `includeSubAgent` makes the alternative a flag we can measure later rather than a design we must pick now. |
| Media type | `application/json` only | `putDataset` declares `multipart/form-data`; both line operations declare `application/json`. An editor over a multipart body is not in scope. |
| Schema preprocessing | A `prepareSchema` step between fetch and `compile`: `v2compat`, string-`layout` normalization, then hide attachment and `x-extension` columns | data-fair's production form does exactly this, and skipping it reproduces the `failed to normalize layout` failure per dataset. Column-shaped rules read from the schema, so they need no annotation. |
| v2 compat source | Vendored, under protest, until json-layout exports it outside vjsf | The layer has no vjsf dependency; depending on `@koumoul/vjsf` from a server library to reach it is worse than a copy with a pointer to the upstream file. |
| Dependency | `@json-layout/agents` as an optional peer, imported lazily | It pulls `@json-layout/core` and its transitive dependencies; a consumer using only read tools should not carry them. |

## The adapter

Three small files:

```
src/editor/session-spec.ts   ResolvedOperation -> SessionSpec (+ the schema-fn map)
src/editor/prepare-schema.ts a fetched schema -> a compilable one
src/editor/bridge.ts         FormTool -> our Tool (name, description, inputSchema, execute)
src/editor/index.ts          buildEditorTools(op, o) -> Tool[]
src/editor/vendor/vjsf-compat-v2.js   copied from @koumoul/vjsf, header pointing home
```

**Resource selection.** `FormSession`'s tools have fixed input schemas and no notion of
which resource is being edited, so the bridge wraps each one: it adds the write operation's
path parameters to the tool's `inputSchema`, resolves the session through
`store.getOrCreate(key, factory)` keyed by those parameters, then delegates the remaining
arguments to the package's tool. The factory creates the `FormSession` and opens it, so a
first call loads and a later call resumes.

**Descriptor bootstrapping.** `getTools()` throws while the session is closed, but `load()`
must publish descriptors before any resource is named and without making an HTTP call. So
at load time we build one throwaway session whose `load` returns `{}` and whose `schema`
returns a literal empty object schema, open it, take its tools for their names, descriptions
and input schemas, and discard it. The eight descriptions then come from the package rather
than being duplicated here — they are the text an agent reads to decide what to call.

**Names.** `<x-agent name>_<verb>`, the verbs being the package's own camelCase names:
`dataset_line_getData`, `_setData`, `_describeState`, `_setFieldValue`,
`_getFieldSuggestions`, `_editArray`, `_saveForm`, `_reloadForm`. `prefixName` does the
prefixing.

**Errors.** `FormSession` throws `sessionError` with a status (`closed`, `readonly`,
`saving`, `invalid`). The bridge turns those into `{ isError: true, text }` results rather
than exceptions, consistent with every other tool in this library: a failed tool call is a
datum the agent can act on, not a crash.

**Changes to `load`.** `resolveOperations` stops throwing on `editor` and instead throws
when the operation has no JSON request body, or names an operation that does not exist
or needs a path parameter the write operation lacks;
`makeTool` returns `Tool[]` for an editor operation and `load` flattens; the guide from
core's `generateSkill` is appended to `instructions` as its own section, keeping phase 1's
rule that skills are text.

## Open questions, to settle by probing before implementation

Cheap to resolve, and better resolved before code than during it.

**Answered: does a fetched dataset schema compile cleanly?** Yes — data-fair generates its
own line-editing form from it in production. With the condition above: through `v2compat`,
and after normalizing string `layout` values. That condition is the finding, not a caveat.

Still open:

1. **Does a fetched line validate against its own fetched schema?** A line carries `_id`
   and other calculated columns. The schema sets no `additionalProperties: false`, so it
   should pass — but "should" is what A6 disproved on the last target, and this is A6's
   question asked of this one. It is the check that would disqualify lines the way A6
   disqualified datasets, so it goes first.
2. **`extension: 'true'` or `calculated: 'false'`?** The form fetches extension columns
   and hides them; the document offers a `calculated` parameter that would drop them
   server-side. Whether those two produce the same column set on a real dataset is a
   single request to find out, and the answer decides whether `schemaParams` filters or
   the adapter does.
3. **What versions the schema?** data-fair's UI versions it by `dataset.updatedAt`, passed
   as a cache-busting query parameter (A7). The editor cannot reach `updatedAt` without a
   dataset GET, so it hashes the response body instead — one 5 KB GET per session open,
   one compilation per distinct schema. If A7's `ETag` recommendation lands, the hash
   becomes a conditional request and the GET goes away too.
4. **Is the save gate worth anything on a plain dataset?** A fetched schema with
   `required: []` and few formats validates almost everything, so the gate may never fire.
   That is not a reason to remove it, but it is a reason not to claim it as a benefit until
   a typed dataset shows it firing.

## Testing

The package carries its own suite (`session.spec.js`, `session-store.spec.js`,
`layout-cache.spec.js`); we do not retest it.

- `prepare-schema` — a fixture schema carrying a v2 keyword, a string `layout`, an
  attachment column and an `x-extension` column comes out compilable, with the last two
  hidden. `compile()` on the fixture is the assertion, not a snapshot of the output.
- `session-spec` — an operation maps to `load`/`save`/`schema`/`options` correctly, with a
  stubbed `fetch` asserting method, URL, query string and body for all three calls;
  `readOperation` absent yields a `load` that makes no request.
- Schema-function identity — two sessions over the same dataset receive the *same* function
  object and compile once; two datasets get two. This is the test that protects the cache.
- Path-parameter matching — a `schemaOperation` needing a parameter the write operation
  lacks fails at `load`, not at call time.
- `bridge` — path parameters are added to each tool's input schema, the session key is
  derived from them, and a `sessionError` becomes an `isError` result rather than a throw.
- Group assembly — eight tools, prefixed, appearing only in a profile that includes the
  operation.
- One end-to-end check against the live API, run by hand and reported — the discipline that
  caught the `agg_size` bug no test saw.

## Non-goals

- No session store, save logic, TTL, concurrency handling or layout caching of our own.
  All of it exists; writing a second one would be the mistake this rewrite exists to avoid.
- **No precompiled-layout source.** Portals holds layouts compiled at build time and
  imported per locale. `SessionSpec.layout` accepts exactly that and wins over `schema`, so
  the package is ready; what is missing is a way for an OpenAPI annotation to name a
  compiled artifact, which is a packaging question, not this one.
- No `patchLine`. PUT submits everything and needs no diff; PATCH would need one. This
  holds the "restrict to PUT" ruling made when the target was datasets.
- No sub-agent mode in this phase — `includeSubAgent` is a flag, so it becomes a
  measurement rather than a decision.
- No vocabulary beyond `editor.{schemaOperation, schemaParams, readOperation}`, which
  extends the existing slot rather than replacing it: `editor: true` keeps meaning
  "edit the declared request body as it stands".
- The package's tools are consumed as they are. If one needs changing, it changes in
  `@json-layout/agents`, where its tests live.
