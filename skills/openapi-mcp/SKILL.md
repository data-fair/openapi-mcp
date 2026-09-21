---
name: openapi-mcp
description: >
  Use when writing, reviewing or debugging `x-agent` annotations in an OpenAPI 3.x
  document for @data-fair/openapi-mcp: choosing which operations become MCP tools, naming
  them, profiles and skills/instructions, parameter overrides, response projections,
  compact request bodies, and json-layout editor tool groups over a write operation.
  Triggers include: "annotate this OpenAPI with x-agent", "expose this API as MCP tools",
  "make this spec agent-readable", an annotation lint error about a description
  contradicting its schema, a request body too large to put in a tool definition, a
  document that validates but produces no tools, a tool appearing in the wrong profile,
  or wanting an agent to edit a document field by field through a form instead of
  submitting a raw request body.
---

# Annotating OpenAPI documents with `x-agent`

`@data-fair/openapi-mcp` turns an OpenAPI 3.x document into MCP tools. Nothing is
generated from the document's generic shape: an operation becomes a tool **only if it
carries an `x-agent` annotation**. The annotation is the entire product surface — what a
tool is called, what an agent sees, which profile exposes it, how input is validated and
how output is rendered all come from it. Everything else in the document stays for humans.

The full reference lives in the project's [`docs/x-agent.md`](https://github.com/data-fair/openapi-mcp/blob/main/docs/x-agent.md).
This skill is the working guide: how to add annotations, what to check, and why the
non-obvious rules exist.

## Install

```sh
npm install @data-fair/openapi-mcp
# only for editor tool groups (optional peers, lazily imported):
npm install @json-layout/agents @json-layout/core
```

## The annotation at a glance

`x-agent` is an object validated by its own JSON schema. Unknown fields or wrong shapes
fail `load` loudly with the JSON path of the offence — a typo never degrades silently into
a missing feature.

| Where | What it controls |
| --- | --- |
| Document root | `namePrefix`, `profiles`, `skills` (global instructions) |
| `tags[]` entry | default `profiles`, `skill` for the tag's operations |
| Operation (`paths.<p>.<method>`) | opt-in, `name`, `title`, `description`, `examples`, `annotations`, `params`, `fixed`, `body`, `response`, `editor` |
| Parameter definition | the same override object as `params.<name>`, usable from a shared `$ref` |
| Response schema property | `hint`, `exclude` |

Every agent-facing string is a plain string or a locale map (`{ en: …, fr: … }`);
`load({ locale })` picks one.

## Workflow: annotating an operation

1. **Pick the operations that deserve a tool.** A tool competes for the agent's attention
   with every other tool, so annotate the operations that answer real questions, not every
   route. Read-only exploration is the common case; write operations get `editor` (below)
   when a raw body would be too much to ask for.

2. **Give each a stable name and a real description.**

   ```yaml
   paths:
     /datasets/{id}/lines:
       get:
         operationId: readLines
         x-agent:
           profiles: [explore]
           name: search_data
           description: Retrieve rows matching filters/text. Not for statistics — use aggregate_data.
   ```

   `name` defaults to snake_case `operationId`; set it explicitly when the operationId is
   not what an agent should read. `description` falls back to `summary`/`description`/
   `operationId`, but a purpose-written one is usually what makes the tool usable. State
   what the tool is **not** for when a sibling tool is close — this is the single highest
   leverage sentence in an annotation.

3. **Gate it with profiles.** Add the operation to a profile (`profiles: [explore]`) and
   declare the profile set at the root, first entry being the default:

   ```yaml
   x-agent:
     profiles:
       explore: { title: Explore, description: Read-only tools }
       write: { title: Edit, description: Editing tools }
   ```

   A tag's `x-agent.profiles` is the default for operations carrying that tag. An operation
   visible in the wrong profile is almost always a missing or misspelled label here, not a
   load bug.

4. **Tune the parameters** where the API's names or constraints don't suit an agent:

   ```yaml
   params:
     q: { name: query, description: Full-text search. }
     qs: { exclude: true }          # noise for agents
     size: { maximum: 100, default: 12 }
     select: { exclude: true }      # if a fields enum is generated instead
   ```

   `exclude` drops a parameter entirely; `fixed` sends a value the agent never sees;
   `required`, `default`, `maximum`, `enum` refine the schema. The same object can sit on
   the parameter definition itself (useful through `$ref`); the operation-level entry wins.

5. **Project and render the response.** Flat, wide JSON is where agents burn context:

   ```yaml
   response:
     rows: /results                       # array of row objects → markdown table
     concise: [id, title, updatedAt]
     detailed: [id, title, summary, description, updatedAt]
     selectParam: select                  # expose a `fields` param from the response schema
     hints: true                          # surface meta.hints as footnotes
   ```

   `concise` + `detailed` generate a `response_format` enum parameter. `selectParam` maps a
   generated `fields` enum onto the API's own projection parameter — it fails at load when
   the response schema declares no properties, so point it at an operation whose schema is
   real, not a synthetic stub. On response schema properties, `x-agent: { hint: … }` adds a
   note next to the value and `x-agent: { exclude: true }` drops it everywhere.

6. **Only if the body is huge, compact it.** `body: compact` replaces a merged body schema
   with one `body` property described by a listing; the real schema still validates before
   the request. Use it when a body schema is thousands of characters (data-fair's is
   28 KB). Otherwise leave `body: flat`.

7. **Verify.** Nothing replaces actually loading the document:

   ```ts
   import { load } from '@data-fair/openapi-mcp'
   const { tools, instructions } = await load(doc, { profile: 'explore', lint: 'warn' })
   console.log(tools.map(t => `${t.name}: ${t.description.split('\n')[0]}`).join('\n'))
   ```

   Check the tool list, the names, the descriptions and the profile each appears in. Run it
   with each profile. For a document served over HTTP, the bundled binary does the same:
   `OPENAPI_URL=… PROFILE=explore npx openapi-mcp`.

## The rule that bites: descriptions must agree with their schema

An annotation may rewrite a description but it cannot change the schema it describes. When
the two drift apart, the agent reads the description, does what it says, and Ajv rejects it
before any request leaves the process — a silent trap, because the description is the only
thing the agent sees. `load` therefore lints descriptions the annotation **authored** and
fails by default on:

- a quoted scalar example (`Example: "-count"`) for an array parameter — show `["-count"]`;
- the words "comma-separated" for an array parameter — the commas are added by the
  serializer, the agent never types them;
- a quoted value the parameter's enum does not allow.

Fix the description, not the lint configuration; `lint: 'warn'` and `lint: 'off'` exist for
upstream documents you cannot edit, not for annotations you are writing. Inherited
descriptions (from the OpenAPI document itself) are never linted.

## Editor tool groups: eight tools instead of one body

When an agent should edit a structured document rather than hand over a whole request
body, put `editor` on the write operation. The operation stops being a one-shot tool and
becomes eight json-layout form tools (`describeState`, `getData`, `setData`,
`setFieldValue`, `getFieldSuggestions`, `editArray`, `saveForm`, `reloadForm`), each taking
the write operation's path parameters.

```yaml
put:
  operationId: updateLine
  x-agent:
    profiles: [write]
    name: dataset_line
    title: { en: Edit a dataset record }
    editor:
      schemaOperation: readSchema     # operation whose response body IS the JSON Schema
      schemaParams: { mimeType: application/schema+json }  # fixed values for it
      readOperation: readLine         # operation that loads the document; omit = create
```

Rules that decide whether this works:

- The write operation must declare an `application/json` request body. Multipart bodies
  are not supported.
- Use `editor: true` only when the declared body schema is already the form schema (it
  carries json-layout `layout` keywords). When the schema comes from the API — dataset
  schemas do — name a `schemaOperation`.
- `schemaParams` exists because documents often under-declare how to ask for a JSON
  schema (a required `mimeType`, an `extension` flag). It sends values the document never
  declared; that is normal here and not an error.
- Path parameters are matched **by name** across the three operations, and a missing one
  fails at load time, not at call time. If `updateLine` needs `id` and `lineId`, every
  named operation must take those names.
- `readOperation` absent means create: the session starts from `{}` and makes no HTTP call.
- Saving sends the whole document (PUT/POST semantics); there is no PATCH diffing, and
  attachment/`x-extension` columns are hidden from the form.
- Install `@json-layout/agents` and `@json-layout/core` (>= 2.10.0); read-only documents
  do not need them.

Full guide: [`docs/editor-tool-groups.md`](https://github.com/data-fair/openapi-mcp/blob/main/docs/editor-tool-groups.md).

## Common failure modes

| Symptom | Cause |
| --- | --- |
| Document validates, no tools | `x-agent` missing, or the profile requested does not include the operation (check tag inheritance) |
| `x-agent invalid at /paths/…` with an unknown field | Typo, or a key used at the wrong scope (e.g. `params` on the root) |
| Tool name is `some_operation_id` | No `name`, and the operationId is not agent-friendly |
| Lint error: scalar example for an array | Description shows `"x"` where the schema is an array — use `["x"]` |
| Lint error: quoted value not in enum | Description quotes a value the enum forbids — fix the description or the enum |
| `editor` fails at load naming a path parameter | The named operation takes a path param the write operation does not supply |
| `editor` fails at load naming an operationId | `schemaOperation`/`readOperation` does not match any operation in the document |
| An editor tool call returns "missing required parameter" | The caller omitted one of the write operation's path parameters |
| A huge schema bloats every tool definition | `body: compact` on the write operation |
| `selectParam` fails at load with "declares no properties" | The response schema it reads from is an empty/synthetic stub; use an operation with a real schema |

## Reference

- Vocabulary reference: `docs/x-agent.md` in the project repo (or the npm page).
- Editor tool groups: `docs/editor-tool-groups.md`.
- Source of truth for shapes: `src/vocabulary/schema.ts` — when in doubt, the validator beats prose.
