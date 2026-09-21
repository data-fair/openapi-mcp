# Editor tool groups — design

*2026-09-21. Experimental; not aiming for production yet.*

## Why

Phase 1 produced read tools from annotations and phase 2 showed they hold up against
hand-written ones. Writing is the half neither covered.

A write operation's request body is a JSON schema, and for the schemas that matter it is
not a small one: data-fair's `datasetPatch` is 26 KB carrying **42 `layout` keywords** and
six `oneOf` branches. An agent asked to emit that document in one shot has to guess which
branch's fields are legal before it knows which branch it is in.

`@json-layout/core` already solves exactly this, in production, through six MCP tools that
let an agent read a form, activate a variant, fill one field at a time and see validation
scoped to what it just changed. Its own README argues the case from measurements: a
`portal-page` schema is 285,874 characters where a whole editing session costs about 7.4 KB
of tool output, and the accepted values of a field are often not in the schema at all.

Wiring those tools onto an annotated write operation is the capability no third-party
OpenAPI-to-MCP generator can offer, and it is the reason this project owns its converter
rather than adopting one.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Form state between calls | An explicit session token in a process-global store | Editing is stateful; the library is not. Keying by token rather than by MCP session is what keeps it working under the binary's per-request `Server` in HTTP mode. |
| Tool surface | Flat — eight tools, profile-gated | Works in every MCP client including the standalone binary, which is what we can test end to end. The sub-agent shape depends on a consumer convention we would be inventing. |
| Dependency | `@json-layout/core` as an optional peer, imported lazily | Nine transitive dependencies is real weight to impose on someone who only wants read tools. |
| Suggestions | json-layout's own `getFieldSuggestions`, given our `fetch` | Keeps the caller's credentials on the one inner tool that touches the network. |
| The guide | Appended to `instructions` as text | Phase 1's rule stands: skills are text, never an executable workflow. |
| Concurrency | None beyond what the API has | Last write wins, as the underlying API already does. We do not invent optimistic concurrency data-fair lacks. |

## Shape

Three new files, and `@json-layout/core` as an optional peer dependency (a devDependency
here, so the tests exercise it). A missing install fails at `load` with
*"operation X declares `editor` but @json-layout/core is not installed"* — the same loud
style as the rest of the vocabulary.

```
src/editor/session-store.ts   token -> { statefulLayout, op, pathParams, createdAt, lastUsed }
src/editor/bridge.ts          WebMCP descriptors -> our Tool shape
src/editor/index.ts           buildEditorTools(op, o) -> Tool[]
```

The construction sequence is the one json-layout's own eval harness uses, so it is
known-good:

```ts
const compiled = compile(bodySchema, { locale })
const tree = compiled.skeletonTrees[compiled.mainTree]
const layout = new StatefulLayout(compiled, tree, { validateOn: 'input', fetchBaseURL }, currentDocument)
const tools = new WebMCP(layout, { dataTitle, prefixName }).getTools()
```

`fetchBaseURL` is the base URL the tools already use, so json-layout's `getFieldSuggestions`
resolves relative `x-fromUrl` paths against the same API. `datasetPatch` carries no
`x-fromUrl` today (zero occurrences), so this is wiring for when it does, not a claim about
now.

`WebMCP.getTools()` returns `{ name, description, inputSchema?, execute(args) →
{ content: [{ type: 'text', text }], isError? } }` and involves no browser — only its
`registerTools()` touches `navigator.modelContext`. The bridge prefixes the name, flattens
`content` to our `text`, and passes `isError` through.

## The session

`_open` and `_submit` are ours. The middle six are json-layout's, unchanged.

**`<name>_open`** takes the operation's path parameters, runs the `readOperation` to fetch
the current document, compiles the body schema, builds the `StatefulLayout` seeded with
that document, stores it, and returns **a token plus the initial `describeState` output** —
so the agent sees the form in the same call instead of being made to ask twice.

With no `readOperation` the session starts from an empty document. That is right for a POST
and wrong for a PATCH, so `editor` on a PATCH or PUT without one is a load-time error.

**`<name>_submit`** takes the token, refuses if the form is invalid — returning the errors,
not the document, which the agent already has — performs the write with the form's data as
the body, discards the session, and renders the response normally. **A failed write keeps
the session alive** so the agent can fix and resubmit rather than start over.

**The store** is process-global and keyed by token, not by MCP session. That is precisely
what lets it survive the binary's per-request `Server` in HTTP mode. Entries carry
`createdAt`/`lastUsed` and are evicted by idle TTL (30 minutes, `editorSessionTtlMs`) and by
a max-entry cap dropping the least recently used. An evicted token returns *"this editing
session expired, call `_open` again"*, never a null dereference.

Two limits, stated here rather than discovered later:

- **Single process only.** Two replicas behind a load balancer do not share sessions. Fine
  for stdio and a single in-stack container. The token indirection is what makes a shared
  store a later swap that does not change the tool surface.
- **No cross-session locking.** Two agents editing the same resource both submit and the
  last wins — what the API already does. If data-fair grows an ETag, `_submit` can carry it.

## Annotation and naming

The vocabulary slot exists from phase 1; only `readOperation` becomes meaningful.

```yaml
x-agent:
  profiles: [edit]
  name: dataset_metadata
  editor: { readOperation: readDescription }
  title: { en: Edit dataset metadata, fr: Éditer les métadonnées }
```

Tools are `<toolName>_<verb>`: `dataset_metadata_open`, `_describe_state`,
`_set_field_value`, `_set_data`, `_edit_array`, `_get_field_suggestions`, `_get_data`,
`_submit`. json-layout's own `prefixName` option does the prefixing, so the six inner names
come from it rather than from us re-deriving them.

Profile gating contains the cost: the group loads only in a profile that includes the
operation, so an `explore` agent never pays for eight definitions.

## Changes to `load`

1. `resolveOperations` currently throws on any `editor` — phase 1's honest placeholder. It
   becomes: throw when `editor` sits on an operation with no JSON request body, or on a
   PATCH/PUT with no `readOperation`.
2. `makeTool` returns `Tool[]` for an editor operation — the group — and `load` flattens.
3. json-layout's `generateSkill` guide is appended to the ToolSet's `instructions` as its
   own section.

The annotation lint applies unchanged. json-layout authors those six descriptions, so they
are authored-not-inherited and get checked: if its guide ever describes a scalar where its
schema wants an array, we learn at `load` rather than from a transcript.

## Testing

The six inner tools are json-layout's and carry its own suite; we do not retest them.

- `session-store` — TTL eviction, LRU cap, the expired-token message. Pure and fast.
- `bridge` — descriptor mapping, including `isError` and multi-block `content`.
- `_open` / `_submit` against a stubbed `fetch` and the **real `datasetPatch` schema** taken
  from the frozen fixture: open seeds from the GET, edits mutate, submit sends the right
  body, an invalid submit refuses with errors, a failed write keeps the session.
- One end-to-end check against the live API, run by hand and reported — the discipline that
  caught the `agg_size` bug no test saw.

## Non-goals

- No sub-agent mode. It is what json-layout ships in production and the obvious next step,
  but it depends on a consumer convention we cannot validate here. Recorded, not built.
- No optimistic concurrency, no locking, no shared session store.
- No new vocabulary beyond `editor.readOperation`.
- The six inner tools are consumed as they are. If one needs changing, it changes in
  json-layout, where its tests and its eval harness live.
