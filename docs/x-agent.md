# The `x-agent` vocabulary

`x-agent` is a vendor extension for OpenAPI 3.x documents. It tells this library which
operations become MCP tools, what those tools are called, and how their input and output
are shaped for an AI agent. Everything else in the document stays for humans; `x-agent`
replaces it for agents only where it is present.

The vocabulary is validated by its own JSON schema before anything is built: an unknown
field, a wrong shape or a bad name pattern fails `load` loudly, with the JSON path of the
offence. Nothing here is silently ignored.

## Localized text

Every agent-facing string is either a plain string or a locale map:

```yaml
description: Fetch the rows matching the filters.
# or
description: { en: Fetch the rows matching the filters., fr: Récupérer les lignes… }
```

`load({ locale })` picks the requested entry and falls back to the first one declared.
The default locale is `en`.

## Where `x-agent` goes

| Place | Controls |
| --- | --- |
| Document root | tool name prefix, profile list, global instructions |
| `tags[]` entry | default profiles and an instruction section for tagged operations |
| Path item method (`get`, `put`, …) | whether the operation is a tool, and everything about it |
| Parameter definition | per-parameter overrides, shareable with an `$ref` |
| Schema property | `hint` and `exclude` on response properties |

## Root

```yaml
x-agent:
  namePrefix: datafair_
  profiles:
    explore: { title: Explore, description: Read-only tools }
    write: { title: Edit, description: Editing tools }
  skills:
    - name: workflow
      description: Start with describe_dataset, then search_data.
      profiles: [explore]
      tools: [describe_dataset, search_data]
```

- **`namePrefix`** — prepended to every generated tool name (pattern `^[a-z0-9_]*$`).
- **`profiles`** — a non-empty map. The **first declared profile is the default** when
  `load` is called without `profile`. Requesting a profile the root does not declare is an
  error.
- **`skills`** — text blocks rendered into the MCP `instructions`, in order. Each has a
  `name`, a localized `description` (markdown), an optional `profiles` filter and an
  optional `tools` list appended as a `Tools: …` line. Skills are text: nothing executable
  is read from them.

## Tags

```yaml
tags:
  - name: Datasets
    x-agent:
      profiles: [explore]
      skill: List and describe datasets before searching their lines.
```

- **`profiles`** — the default for operations carrying this tag, used when the operation
  does not set its own. The first tag with a `profiles` value wins.
- **`skill`** — an instruction section, emitted when at least one resolved operation
  carries the tag.

## Operation

The presence of `x-agent` on an operation or method is what opts it in. Without it the
operation is not exposed at all.

| Field | Type | Notes |
| --- | --- | --- |
| `profiles` | `string[]` or `true` | Inherited from the tag, then `true` by default. `true` means every profile. |
| `name` | string | Tool name, pattern `^[a-z0-9_]+$`. Default: snake_case `operationId`. |
| `title` | localized | Tool title. |
| `description` | localized | Tool description. Falls back to `summary`, then `description`, then `operationId`. |
| `examples` | object[] | Passed through as MCP tool examples. |
| `annotations` | object | MCP hints: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Defaults: `readOnlyHint` for GET/HEAD, `destructiveHint` for DELETE. |
| `params` | map | Per-parameter overrides, keyed by the API parameter name. |
| `fixed` | object | Values sent on every call and never exposed in the input schema. |
| `body` | `flat` \| `compact` | How a JSON request body reaches the input schema. |
| `response` | object | Projection and rendering of the response. |
| `editor` | `true` or object | Expose json-layout form tools instead of a one-shot tool. See [editor tool groups](./editor-tool-groups.md). |

### Parameter overrides

```yaml
params:
  q: { name: query, description: Full-text search. }
  size: { maximum: 100, default: 12 }
  qs: { exclude: true }
  format: { exclude: true }
```

| Field | Effect |
| --- | --- |
| `name` | Rename the tool-facing parameter (pattern `^[a-zA-Z_][a-zA-Z0-9_]*$`). |
| `description` | Localized description, replacing the inherited one. |
| `exclude` | Drop the parameter from the input schema and from requests. |
| `default` | JSON-schema default; Ajv fills it in before the request. |
| `maximum` | JSON-schema maximum. |
| `enum` | Restrict the accepted values. |
| `required` | Force the parameter to be required by the input schema. |

The same override object may sit directly on a parameter definition, which is useful when
a document `$ref`s a shared parameter; the operation-level `params` entry wins per key.

A parameter excluded with `exclude`, named in `fixed`, or used as `response.selectParam`
does not appear in the input schema.

### Request bodies

Only `application/json` request bodies are used. With `body: flat` (the default) an
object body's properties are merged at the top level of the input schema; a name that
collides with a parameter gets a `__body` suffix. A non-object body, or `body: compact`,
exposes a single `body` property.

`body: compact` is for schemas too large to put in a tool definition — data-fair's dataset
body is 28 KB. The property's description is a compact listing (name, required, type,
allowed values, short description) and the real schema validates the value before any
request is sent, so a caller that misreads the listing gets a local JSON path and keyword
instead of a round trip.

### Responses

```yaml
response:
  rows: /results
  concise: [id, title, updatedAt]
  detailed: [id, title, summary, description, updatedAt]
  selectParam: select
  hints: true
```

| Field | Effect |
| --- | --- |
| `rows` | Single-segment pointer to the array of row objects (`^/[^/]+$`). The renderer shows it as a markdown table. |
| `concise` | Projection preset: fields for the default `response_format: concise`. |
| `detailed` | `true` for every field, or a field list, for `response_format: detailed`. `concise` and `detailed` together generate the `response_format` enum parameter. |
| `selectParam` | Name of the API's own projection parameter. Generates a `fields` parameter whose enum is read from the response schema, and maps it onto that API parameter. Fails at load when the response schema declares no properties. |
| `hints` | Surface `meta.hints` from the response as `> Hint:` footnotes. |

Projection order when rendering: explicit `fields` from the caller, then
`response_format`, then `concise`, then everything.

### Schema properties

`x-agent` on a response schema property accepts exactly two keys:

- **`hint`** — a localized note rendered next to the field, in tables and key/value output.
- **`exclude`** — drop the property, at every depth, from rendering and from generated
  `fields` enums.

## Loading

```ts
import { load } from '@data-fair/openapi-mcp'

const { profile, instructions, tools } = await load(docOrUrl, {
  profile: 'explore',   // default: the first profile declared at the root
  fetch: myFetch,       // default: globalThis.fetch; carries credentials
  locale: 'en',         // default: 'en'
  baseUrl: 'https://api.example.com/v1', // default: servers[0].url
  structuredContent: false, // also return structuredContent from tool calls
  maxStringLength: 500, // truncation limit in rendered text
  maxErrorLength: 4000, // truncation limit for HTTP error bodies
  lint: 'error'         // 'error' | 'warn' | 'off'
})
```

`load` inlines local `$ref`s (cycles become `{}`), validates the vocabulary, resolves the
operations for the profile, and returns provider-agnostic tools:

```ts
interface Tool {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations: ToolAnnotations
  examples?: Record<string, unknown>[]
  execute (params: Record<string, unknown>): Promise<{ text: string, structuredContent?: unknown, isError?: boolean }>
}
```

Every tool execution returns a result; it never throws. Invalid input, HTTP errors and
network failures all come back as `{ isError: true, text }`. Non-2xx bodies are returned
verbatim (truncated) because an API's error text is usually the agent's self-correction
channel.

When an operation's 2xx response offers `text/markdown`, the request asks for it and the
body is passed through untouched — the API renders, this library does not.

## Annotation lint

An annotation may rewrite a description but cannot change the schema it describes, so the
two can drift apart — and then the model reads the description, does what it says, and Ajv
rejects it before any request is sent. `load` lints descriptions the annotation **authored**
(inherited ones belong upstream) and reports three mechanical disagreements:

- a description showing a quoted scalar example for an array parameter;
- a description saying "comma-separated" for an array parameter;
- a description quoting a value the parameter's enum does not allow.

The default `lint: 'error'` refuses the tool set, listing every finding at once.
`lint: 'warn'` prints and continues; `lint: 'off'` skips the check.

## Not in the vocabulary

Templates, hooks, executable composition, jq and codegen. `x-agent` describes an API to an
agent; it does not add behaviour to it. An annotation names at most one other operation —
`editor.readOperation` and `editor.schemaOperation` — because a form has to say which
document it reads and which schema it compiles, not because workflows are expressible.
