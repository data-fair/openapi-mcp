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
    write_datasets: { title: Edit datasets }
    write: { title: Edit, description: Editing tools, includes: [write_datasets] }
  skills:
    - name: workflow
      description: How to explore datasets. Use it before searching or aggregating data.
      href: agents/skills/workflow.md
      profiles: [explore]
      tools: [describe_dataset, search_data]
```

- **`namePrefix`** — prepended to every generated tool name (pattern `^[a-z0-9_]*$`).
- **`profiles`** — a non-empty map. The **first declared profile is the default** when
  `load` is called without `profiles`. Requesting a profile the root does not declare is an
  error. `includes` names other declared profiles: requesting this one also selects their
  operations. Expanded transitively; a cycle or an undeclared name refuses the document.
- **`skills`** — skills in the Agent Skills sense. `description` (localized, at most 1024
  characters) says what the skill is for and when to use it: it is always shown, in the MCP
  `instructions`. The body is read on demand as the `skill://…/SKILL.md` resource: inline in
  `body`, or in a markdown file linked by `href` (localized; relative to the URL the document was
  fetched from, or to `servers[0].url` for a document passed as an object). `href` and `body` are
  exclusive; with neither, the description is the body. A linked file's frontmatter is ignored.
  `profiles` filters, `tools` adds a `Tools: …` line. The name follows the Agent Skills format
  (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters) and becomes the last segment of
  `skill://…/<name>/SKILL.md`.

## Recommended profile names

A consumer asks every service of a deployment for the same profile names, so the same name
should mean the same thing everywhere:

- `explore` — read-only: listing, describing, querying.
- `edit` — everything `explore` has, plus the writes an ordinary user of the service
  performs. Per-resource subsets (`edit_datasets`, `edit_applications`) are declared and
  `edit` `includes` them.
- `admin` — operations reserved to administrators.

A service that has nothing for a name simply does not declare it; a consumer requesting it
gets that service's contribution to the other names in the set. Convention, not validation.

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
| `bodyFields` | string[] | Allow-list of request body properties this tool offers. See [Request bodies](#request-bodies). |
| `bodyRequired` | string[] | Body properties this tool requires, on top of the schema's `required`. See [Request bodies](#request-bodies). |
| `response` | object | Projection and rendering of the response. |
| `editor` | `true` or object | Expose json-layout form tools instead of a one-shot tool. See [editor tool groups](./editor-tool-groups.md). |

### Views: several tools from one operation

`x-agent` on an operation may be an array. Each element is a **view** — a complete operation
annotation producing a tool of its own, with its own profiles, description, annotations,
parameters and body fields. Use it when one endpoint does things of different criticality
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

A tool sends one of the bodies an operation declares: `application/json` first, then
`multipart/form-data`, then a raw body whose media type is not JSON, multipart or
form-urlencoded (`text/csv`, `application/x-ndjson`…). A JSON tool therefore stays what it was
when the operation also accepts an upload. Other bodies (`application/merge-patch+json`,
form-urlencoded) are not sent. Multipart parts and raw bodies that carry a file become file
inputs: see [Files](#files). With `body: flat` (the default) an object body's properties
(JSON properties, or multipart parts) are merged at the top level of the input schema; a name
that collides with a parameter gets a `__body` suffix. A non-object JSON body, or
`body: compact`, exposes a single `body` property; `body: compact` needs a JSON body.

`body: compact` is for schemas too large to put in a tool definition — data-fair's dataset
body is 28 KB. The property's description is a compact listing (name, required, type,
allowed values, short description) and the real schema validates the value before any
request is sent, so a caller that misreads the listing gets a local JSON path and keyword
instead of a round trip.

`bodyFields` restricts the body to an allow-list of its properties. The schema is pruned before
the `flat`/`compact` choice, so the merged properties, the compact listing and the local
validation all agree, and any other property is refused before a request is sent. It needs a
JSON or multipart request body that is an object with declared properties, and every listed name must be
one of them; both are checked when the document loads, on every view whatever profiles are
requested. It does not combine with `editor`: a form group edits the whole document, so the
two together are refused. An allow-list rather than a deny-list: a property added to the API
later is offered by no tool until an annotation places it.

`bodyRequired` makes body properties required for this tool, on top of those the schema
requires; each must be one the tool offers (in `bodyFields` when there is one). It is for an
operation that serves several purposes through one body while a tool is about one of them:
data-fair's `POST /datasets` creates a dataset from a file, or without one from another dataset
or as an editable dataset, so its document rightly declares the file part optional; its
`create_dataset_from_file` view declares `bodyRequired: [file]`. Required-ness also decides
whether a tool exists: a required file part makes the tool unavailable when no file store is
configured (see [File inputs](#file-inputs)), so the tool is not offered without the one argument
it is about. Checked at load on every view, like `bodyFields`; refused on an editor group.

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
| `file` | `true`: the response is a file. The tool sends no request and returns a link to it. GET only; excludes every other key. See [File outputs](#file-outputs). |

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

const { profiles, instructions, tools, skills } = await load(docOrUrl, {
  profiles: ['explore', 'edit'], // default: the first profile declared at the root; `profile` is one-element sugar
  namePrefix: undefined, // replaces the root namePrefix ('' strips it) — for compatibility routes
  fetch: myFetch,       // default: globalThis.fetch; carries credentials
  locale: 'en',         // default: 'en'
  baseUrl: 'https://api.example.com/v1', // default: servers[0].url
  structuredContent: false, // also return structuredContent from tool calls
  maxStringLength: 500, // truncation limit in rendered text
  maxErrorLength: 4000, // truncation limit for HTTP error bodies
  lint: 'error',        // 'error' | 'warn' | 'off'
  files: {              // file inputs (indirect uploads), see Files
    urlPrefixes: ['https://s3.example.com/agents-bucket/'], // the file store; none: file inputs off
    maxSize: 104857600, // bytes; published as x-mcp-file.maxSize
    timeout: 300000     // ms, request to last byte
  }
})
```

`load` inlines local `$ref`s (cycles become `{}`), validates the vocabulary, resolves the
operations for the profile set — an operation in any requested profile, after `includes`
expansion, is selected once — and returns provider-agnostic tools plus the text-only
`skills` the set selects:

```ts
interface Tool {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations: ToolAnnotations
  examples?: Record<string, unknown>[]
  execute (params: Record<string, unknown>, ctx?: CallContext): Promise<{ text: string, structuredContent?: unknown, resourceLink?: { uri: string, name: string, mimeType?: string }, isError?: boolean }>
}

interface CallContext {
  fetch?: typeof fetch                // wins over the load-time fetch for this call
  headers?: Record<string, string>    // merged into the upstream request
  signal?: AbortSignal
  identity?: string                   // partitions editor sessions per caller
}
```

Every tool execution returns a result; it never throws. Invalid input, HTTP errors and
network failures all come back as `{ isError: true, text }`. Non-2xx bodies are returned
verbatim (truncated) because an API's error text is usually the agent's self-correction
channel.

When an operation's 2xx response offers `text/markdown`, the request asks for it and the
body is passed through untouched — the API renders, this library does not.

## Files

A tool takes a file as a **URL** and returns one as a **link**. No file bytes travel through the
model, and none through the MCP protocol: the caller — an agent runtime with its own file store —
hands out a URL the server can fetch, and fetches the links it gets back. This is the shape the
MCP specification already gives file outputs (a tool result may hold a `resource_link` whose
`https` URI the client fetches itself — [MCP 2026-07-28, tools](https://modelcontextprotocol.io/specification/latest/server/tools)
and resources), and the one ChatGPT's Apps SDK gives file inputs: arguments listed in
`openai/fileParams` receive a temporary download URL that the MCP server fetches
([Apps SDK reference](https://developers.openai.com/apps-sdk/reference)).

### File inputs

File inputs are **indirect uploads**. The caller puts the file in its own store, signs a short-lived
GET URL for it (a presigned URL), and passes that URL; this server fetches it and streams it to the
API. That is their only purpose: the server fetches the URLs of the store it is configured for, and
nothing else. Downloading an arbitrary resource on a client's behalf — a public URL found on the
web — is not a supported case.

`files.urlPrefixes` (`FILE_URL_PREFIXES` for the binary) names the store: its endpoint and bucket
path, e.g. `https://s3.example.com/agents-bucket/`. **Without a prefix, file inputs are off.**
Optional file parts are not offered. An operation whose body needs a file is not offered as a tool
at all (a `debug` line names it): a required file part, or a required raw body.

The inputs are detected from standard OpenAPI; there is nothing to annotate.

- A `multipart/form-data` part with `format: binary` (OpenAPI 3.0) or a `contentMediaType`
  (OpenAPI 3.1, which replaced `format: binary` with it — [OAS 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)).
  A part that also has a `contentEncoding` (base64) is inline text, not a file. Each such part is
  one input, named after it.
- A raw request body (see [Request bodies](#request-bodies)): one input named `file`
  (`file__body` when a parameter already has that name).

A part that is a list of files is not offered, because an input carries one URL. An operation
that requires one is not offered either. Every other multipart part is an ordinary input.

Each file input is:

```json
{ "type": "string", "format": "uri", "description": "…", "x-mcp-file": { "accept": ["text/csv"], "maxSize": 104857600 } }
```

- `accept`: the part's `encoding.<part>.contentType` (a comma-separated list), else its
  `contentMediaType`, else the raw body's media types. `application/octet-stream` says nothing
  and is left out.
- `maxSize`: the size this library accepts (`files.maxSize`), so a caller can check before signing.
- Why not `contentMediaType`: in JSON Schema it says the string *is* the content, possibly
  encoded with `contentEncoding` ([2020-12 validation §8.4](https://json-schema.org/draft/2020-12/json-schema-validation#section-8)),
  so a client would put the bytes there. Here the string is a reference.
- Why `x-mcp-file`: it is the keyword of the MCP file-input proposals —
  [SEP-2356](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2356), superseded
  by the open draft [SEP-2631](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631)
  (File Uploads working group). A client that knows it can offer a file picker or a file store;
  one that does not sees a URI string. Only top-level properties carry it, as with
  `openai/fileParams`.

At execution, before the upstream request:

- **Only the store's URLs.** A URL is fetched only if, once parsed and normalized, it starts with
  a configured prefix at a boundary. Normalization (WHATWG URL) resolves dot segments, `..` as
  well as `%2e%2e`, lowercases the host and drops a default port. At a boundary means the prefix
  ends with `/`, `?`, `&` or `=`, or the URL continues with `/` or `?`: the prefix
  `…/bucket` admits `…/bucket/report.csv`, never `…/bucket-evil/report.csv`. Prefixes are
  http(s) URLs without credentials, so a URL with credentials, another scheme or another host
  never matches. Anything else is refused before any connection.
- **Why an allowlist, not SSRF protection.** A general client for user-chosen URLs needs
  address checks at connection time (private ranges, DNS rebinding, every redirect hop). This
  server has no user-chosen URLs: its one target is a fixed endpoint the deployment trusts. An
  allowlist is the narrower rule — a public host outside the store is refused too — and has no DNS
  or proxy subtleties.
- **Fetch without credentials.** A plain GET (Node's `http` / `https`), with none of the call's
  context (`headers`, `fetch`) and not the load-time `fetch`: a presigned URL authorizes itself,
  and the caller's cookies or API key never reach it.
- **No redirect, no encoding.** A presigned GET answers directly, so a 3xx is an error, never
  followed. A response with a `Content-Encoding` other than `identity` is refused: no encoding is
  asked for, so it is an object stored compressed, its bytes are not the file, and decoding it
  would lose the exact length the upload needs.
- **Bounds.** `files.maxSize` (100 MiB) is checked against the source's `Content-Length` before
  anything is read, and the bytes read must match it. `files.timeout` (300 s) runs from the
  request to the last byte, and the call's abort signal stops it too.
- **Streamed with an exact `Content-Length`.** The upstream request's length is computed before its
  first byte: the source's `Content-Length` plus the multipart framing (boundaries, part headers,
  fields, as the `form-data` package computes it). It is never sent `Transfer-Encoding: chunked`: an API that checks a quota before
  accepting an upload needs the size first — data-fair answers 411 to a chunked upload. A source
  without `Content-Length` is therefore refused rather than buffered in memory, and a source that
  sends fewer bytes than it declared fails the upload instead of truncating it.
- **Sources live as long as the exchange.** Every file is opened before the request, because the
  length needs every size. They are released only after the upstream response body has been read:
  closing one earlier errors the request body, and the HTTP client then terminates the response
  still arriving with it. They are also released when the call fails, so an API that answers
  early (413, 401) without reading the body does not keep a large file streaming for nothing. An
  upstream error comes back as an `isError` text, `HTTP <status>: <body>`, like any other call.
- **File name** = the URL path's last segment, percent-decoded (`…/report.csv?X-Amz-Signature=…`
  → `report.csv`). APIs often type an upload by its name — data-fair uses the extension, not the
  declared type — so the URL must end with the name, extension included.
- **Encoding** (the `form-data` package). Fields first, then files (a server that filters files as they arrive, like multer,
  has only seen the fields sent before them). An object or array field is sent as JSON text
  (OpenAPI's default content type for an object part; data-fair parses array parts as JSON too), a
  scalar as its string form. Names are escaped as browsers do (`"`, CR, LF percent-encoded) and
  sent as UTF-8. A file part's `Content-Type` is the source's, else the first
  accepted type, else `application/octet-stream`. A raw body's `Content-Type` is the source's when the operation declares it, else
  the first declared one.
- **Proxy.** With `NODE_USE_ENV_PROXY=1`, Node 24 routes `http.get`/`https.get` through
  `HTTP_PROXY`/`HTTPS_PROXY` as it does `fetch`, so the file fetch would go through a
  credential-injecting proxy (e.g. nhi-proxy) and carry its credentials, which this server otherwise
  never sends to file URLs (and S3 rejects a presigned GET that carries an `Authorization` header).
  Put the file store's host in `NO_PROXY`.
- **Errors** before the request come back as tool errors naming the input and the URL without its query string, which
  may carry a signature: `File "file" (https://s3…/report.csv) could not be fetched: HTTP 403`.

### File outputs

`response: { file: true }` on a GET operation declares that its response is a file. Declared,
not guessed from media types: a response whose type depends on a parameter (`/lines?format=csv`)
is made a file by a `fixed` value.

```yaml
get:
  operationId: readLines
  x-agent:
    name: export_lines
    fixed: { format: csv }
    response: { file: true }
```

Such a tool sends no request. It validates its arguments, builds the URL a call would use (the
same `buildRequest` as any call: path, query and `fixed` parameters, the latter in the query
string) and returns a `resource_link` plus a text block naming the file and the URL, for clients
that ignore links:

```json
[
  { "type": "text", "text": "File rge-lines.csv (text/csv), not downloaded by this tool: https://…/datasets/rge/lines?format=csv" },
  { "type": "resource_link", "uri": "https://…/datasets/rge/lines?format=csv", "name": "rge-lines.csv", "mimeType": "text/csv" }
]
```

- `mimeType`: the success response's media type when one is declared; among several, the one
  that a `format` query value names by extension (`format=csv` → `text/csv`); else none.
- `name`: the value of the last path parameter followed by the segments after it
  (`/datasets/{id}/lines` → `rge-lines`), so exports of two resources do not collide in a file
  store; characters outside `[A-Za-z0-9._-]` become `-`; the extension of `mimeType` is appended
  when the name has none (not for `application/octet-stream`).
- The client fetches the link with its own credentials, like any call to the API: the bytes never
  cross this server.
- A header parameter cannot be part of a link: an operation exposing one refuses the tool set.
  `response.file` excludes `rows`, `concise`, `detailed`, `selectParam`, `hints` and `editor`;
  such a tool declares no `outputSchema`.

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

## Forward compatibility

The vocabulary grows, and its schemas are strict: a server one version behind meets keys it
does not know. What happens depends on `lint`:

- Errors in the root `x-agent`, a tag's, or anything not attributable to one operation fail the
  document, whatever the level.
- Errors attributable to one operation's `x-agent` (unknown key, invalid value, a failed
  cross-field rule such as `response.file` on a non-GET, `bodyFields`/`bodyRequired` naming
  missing properties, `body: compact` on a non-JSON body) behave per level:
  - `lint: 'error'` (the default) fails the document with the message of the finding;
  - `lint: 'warn'` leaves that operation out, with all its views, loads every other operation
    and prints one `console.warn` listing each left-out operation (method, path) and the reason;
  - `lint: 'off'` does the same silently.

Leaving the operation out is fail-closed on purpose: ignoring an unknown key could change what
the tool means (an ignored `response.file` would download a file as text; an ignored
`bodyRequired` would offer an upload tool without its file). The service stays `ok` in a
composition and serves its other tools. Authoring and CI must run with `lint: 'error'` to catch
mistakes. Servers older than this behaviour (up to 0.4.0) still drop the whole service on such
a key, so deploy openapi-mcp before publishing documents that use new keys.

## Not in the vocabulary

Templates, hooks, executable composition, jq and codegen. `x-agent` describes an API to an
agent; it does not add behaviour to it. An annotation names at most one other operation —
`editor.readOperation` and `editor.schemaOperation` — because a form has to say which
document it reads and which schema it compiles, not because workflows are expressible.
