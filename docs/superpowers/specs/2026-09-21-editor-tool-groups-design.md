# Editor tool groups — design

*2026-09-21. Experimental; not aiming for production yet.*
*Rewritten after finding `@json-layout/agents`, which implements most of what an earlier
draft of this document specified from scratch.*

## Why

Phase 1 produced read tools from annotations; phase 2 showed they hold up against
hand-written ones. Writing is the half neither covered.

For a body whose difficulty is only its **size**, the answer is already built: `body:
compact` renders the schema as a listing and validates the real thing at execution, taking
data-fair's dataset write tool from 28,033 characters to 2,840.

This document is for the other case — a body whose difficulty is **branching and remote
values**. data-fair's `datasetPatch` carries 42 `layout` keywords and six `oneOf` branches:
which fields are legal depends on which branch is active, and an agent emitting the
document in one shot has to guess the branch before it knows it is in one. That is what
`@json-layout/core` solves, in production, through tools that let an agent read a form,
activate a variant, fill one field at a time and see validation scoped to what it changed.

## What already exists, and what is left for us

`@json-layout/agents` is the server-side half of that story, and it is nearly all of this
feature:

| Concern | Where it lives |
|---|---|
| Session lifetime, sliding TTL, eviction, concurrent-call de-duplication | `SessionStore` (`getOrCreate` shares one factory run per key) |
| Open, reload, save; status machine (`closed`/`opening`/`ready`/`stale`/`saving`/`error`) | `FormSession` |
| The save gate | `save()` refuses when `!valid` unless `allowInvalid` |
| In-flight save protection | `save()` rejects a second save while one is running |
| Optimistic concurrency | `SaveContext { version, base }`, `unwrapEnvelope` |
| Compiled-layout reuse across sessions | `resolveCompiledLayout` / `clearLayoutCache` |
| Tool surface | `session.tools` — core's six plus `saveForm` and `reloadForm` |
| Flat vs sub-agent | `includeSubAgent`, `includeFillFormSkill` flags |
| Tool prefixing | `prefixName` |

**What is left for us is one adapter**: turn an annotated OpenAPI operation into a
`SessionSpec`, and give the agent a way to say *which* resource it is editing.

```
SessionSpec.load()   -> GET via the annotation's readOperation
SessionSpec.save()   -> the annotated write operation
SessionSpec.schema() -> the operation's request body schema, from the document
SessionSpec.options  -> { fetch, fetchBaseURL } — the caller's credentials, as everywhere else
SessionSpec.title    -> the operation's x-agent title
```

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Session identity | The resource's own path parameters, as the store key | The package documents keying by `${userId}:${resourcePath}:${recordId}`. The resource id *is* the token, so there is nothing opaque to carry and re-opening the same dataset resumes rather than reloads. |
| Resource selection | Every editor tool takes the operation's path parameters | No hidden "current form". Two datasets can be edited in one session without a mode. |
| Validity gate | `FormSession`'s own, `allowInvalid` left at its default | It already exists and reports the errors; adding ours would be a second gate disagreeing with the first. |
| Descriptor bootstrapping | Open a throwaway session over a stub `load` at `load()` time | Tool descriptions come from the package rather than being re-typed here, and it costs no HTTP. See below. |
| Tool surface | Flat, profile-gated | `includeSubAgent` makes the alternative a flag we can measure later rather than a design we must pick now. |
| Dependency | `@json-layout/agents` as an optional peer, imported lazily | It pulls `@json-layout/core` and nine transitive dependencies; a consumer using only read tools should not carry them. |

## The adapter

Three small files:

```
src/editor/session-spec.ts   ResolvedOperation -> SessionSpec
src/editor/bridge.ts         FormTool -> our Tool (name, description, inputSchema, execute)
src/editor/index.ts          buildEditorTools(op, o) -> Tool[]
```

**Resource selection.** `FormSession`'s tools have fixed input schemas and no notion of
which dataset is being edited, so our bridge wraps each one: it adds the operation's path
parameters to the tool's `inputSchema`, resolves the session through
`store.getOrCreate(key, factory)` keyed by those parameters, then delegates the remaining
arguments to the package's tool. The factory creates the `FormSession` and opens it, so a
first call loads the document and a later call resumes the same form.

**Descriptor bootstrapping.** `session.tools` throws while the session is closed, but
`load()` must publish tool descriptors before any resource is named and without making an
HTTP call. So at load time we build one throwaway session whose `load` returns `{}` — a
literal, no I/O — open it, take its `tools` for their names, descriptions and input
schemas, and discard it. The eight descriptions then come from the package rather than
being duplicated here, which matters because they are the text an agent reads to decide
what to call.

**Errors.** `FormSession` throws `sessionError` with a status (`closed`, `readonly`,
`saving`, `invalid`). The bridge turns those into `{ isError: true, text }` results rather
than exceptions, consistent with every other tool in this library: a tool call that fails
is a datum the agent can act on, not a crash.

## Annotation

The vocabulary slot exists from phase 1; only `readOperation` becomes meaningful.

```yaml
x-agent:
  profiles: [edit]
  name: dataset_metadata
  editor: { readOperation: readDescription }
  title: { en: Edit dataset metadata, fr: Éditer les métadonnées }
```

Tools are `<toolName>_<verb>`, and the verbs are the package's own camelCase names:
`dataset_metadata_describeState`, `_setFieldValue`, `_setData`, `_editArray`,
`_getFieldSuggestions`, `_getData`, `_saveForm`, `_reloadForm`. `prefixName` does the
prefixing.

`load` changes in three places: `resolveOperations` stops throwing on `editor` and instead
throws only when the operation has no JSON request body or names no `readOperation`;
`makeTool` returns `Tool[]` for an editor operation and `load` flattens; and the guide from
core's `generateSkill` is appended to `instructions` as its own section, keeping phase 1's
rule that skills are text.

## Open questions, to settle by probing before implementation

Two things an earlier probe surfaced that this design does not yet answer, both cheap to
resolve and both better resolved before code than during it:

1. **Does a real fetched document validate against the write schema?** Seeding a layout
   with a stub produced three errors on `datasetPatch`'s `/rest` branch before any edit.
   If a real document does the same, `allowInvalid` becomes a per-operation annotation
   rather than a default; if it validates, the gate is simply the package's.
2. **Does `datasetPatch` compile cleanly?** The same probe emitted `failed to normalize
   layout, use default component` and `/title must be string`, which suggests some of its
   42 `layout` keywords are vjsf-v2 style and would need the compatibility layer
   json-layout applies to `app-calendar` in its own eval. That would be real extra scope.

A third, smaller: `putDataset` declares `multipart/form-data`, not `application/json`, so
the operation `editor` attaches to may need to be `patchDataset` — or the annotation may
need to name the media type. To check against the frozen document.

## Testing

The package carries its own suite (`session.spec.js`, `session-store.spec.js`,
`layout-cache.spec.js`); we do not retest it.

- `session-spec` — an operation maps to `load`/`save`/`schema`/`options` correctly, with a
  stubbed `fetch` asserting the right method, URL and body.
- `bridge` — path parameters are added to each tool's input schema, the session key is
  derived from them, and a `sessionError` becomes an `isError` result rather than a throw.
- Group assembly — eight tools, prefixed, profile-gated, appearing only in a profile that
  includes the operation.
- One end-to-end check against the live API, run by hand and reported — the discipline that
  caught the `agg_size` bug no test saw.

## Non-goals

- No session store, save logic, TTL, concurrency handling or layout caching of our own.
  All of it exists; writing a second one would be the mistake this rewrite exists to avoid.
- No sub-agent mode in this phase — `includeSubAgent` is a flag, so it becomes a
  measurement rather than a decision.
- No new vocabulary beyond `editor.readOperation`.
- The package's tools are consumed as they are. If one needs changing, it changes in
  `@json-layout/agents`, where its tests live.
