# The `x-agent` vocabulary

`x-agent` is an OpenAPI 3.x extension. It says which operations become MCP tools, what they are
called, and how their input and output are shaped for an agent. Its own JSON schema validates it
before anything is built: an unknown key or a wrong shape fails `load` with the JSON path of the
offence (see [Loading](#loading) for the lenient levels).

Examples below use an articles API with the scopes `articles:read`, `articles:write` and
`articles:admin`.

## Localized text

An agent-facing string is a plain string or a locale map: `{ en: Publish the article., fr: … }`.
`load({ locale })` picks the requested locale, else `en`, else the first one declared.

## Where `x-agent` goes

| Place | Controls |
| --- | --- |
| Document root | `skills` |
| `tags[]` entry | `guide`: an instructions section about the tag's tools |
| Operation | whether it is a tool, and everything about it |
| Parameter definition | the same overrides as an operation's `params`, shareable through `$ref` |
| Schema property | `hint` and `exclude`, for rendering responses |

## Root

```yaml
x-agent:
  skills:
    - name: publishing
      description: How to publish an article. Use it before calling publish_article.
      href: agents/skills/publishing.md
      tools: [update_article, publish_article]
```

`skills` are Agent Skills. `description` (localized, at most 1024 characters) is always shown: in
the MCP instructions, or in `skills/list` for a client that lists skills itself. The body is read on demand as `skill://<name>/SKILL.md`: inline in `body`,
or a markdown file linked by `href` (localized; relative to the URL the document was fetched from,
or to `servers[0].url`). `href` and `body` exclude each other; with neither, the description is
the body, and a linked file's frontmatter is ignored. `tools` adds a `Tools:` line; a skill keeps
only the tools that were built, and goes when none was (or when `toolsForScopes` keeps none). `name` follows the Agent Skills
format: `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters.

## Tags

```yaml
tags:
  - name: Articles
    x-agent:
      guide: Articles are drafts until published. Read one before editing it.
```

`guide` is a section of the MCP instructions, titled with the tag's name. It is emitted when an
operation carrying the tag became a tool, and kept by `toolsForScopes` while one of those tools is.

## Operation

The presence of `x-agent` on an operation is what makes it a tool.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Tool name, `^[a-z0-9_]+$`. Default: snake_case `operationId`. |
| `title` | localized | Tool title. |
| `description` | localized | Tool description. Default: `summary` and `description`, else `operationId`. |
| `examples` | object[] | Input examples, passed through. |
| `annotations` | object | MCP hints: `readOnlyHint` (default for GET and HEAD), `destructiveHint` (default for DELETE), `idempotentHint`, `openWorldHint`. |
| `params` | map | [Parameter overrides](#parameter-overrides), by API parameter name. |
| `fixed` | object | Query values sent on every call and never exposed. |
| `body`, `bodyFields`, `bodyRequired` | | See [Request bodies](#request-bodies). |
| `response` | object | See [Responses](#responses). |
| `editor` | `true` or object | Form tools instead of one tool: see [editor tool groups](./editor-tool-groups.md). |
| `security` | requirement[] | Narrows the operation's security for this tool: see [Security](#security). |

### Views

`x-agent` may be an array of views, each a complete annotation producing a tool of its own. Use
it when one operation does things of different criticality depending on its payload:

```yaml
patch:
  operationId: patchArticle
  security: [{ oauth2: [articles:write] }, { oauth2: [articles:admin] }]
  x-agent:
    - { name: update_article, bodyFields: [title, body] }
    - { name: publish_article, bodyFields: [published], security: [{ oauth2: [articles:admin] }] }
```

Every view needs a `name`, unique within the array. `editor.readOperation` and
`editor.schemaOperation` name the raw operation, not its views.

### Security

A tool carries its operation's `security`, else the document's root `security`, else none. An
entry's `security` (OpenAPI's shape) replaces it for that tool, and can only narrow it: each
alternative must be one the operation declares (in any key or scope order), and `security: []`
is accepted only on an operation that is already public. Above, an `articles:write` token is
offered `update_article` and not `publish_article`, which the API would refuse it. A widening
alternative is refused like any invalid annotation:
`publish_article: x-agent security alternative {"oauth2":["articles:read"]} is not in the operation's security`.

`toolsForScopes` reads this: see the README. Security only chooses which tools a token is offered;
the API still authorizes every call.

### Parameter overrides

```yaml
params:
  q: { name: query, description: Full-text search. }
  size: { maximum: 100, default: 12 }
  debug: { exclude: true }
```

| Field | Effect |
| --- | --- |
| `name` | Tool-facing name, `^[a-zA-Z_][a-zA-Z0-9_]*$`. |
| `description` | Replaces the inherited description. |
| `exclude` | Drops the parameter from the tool. |
| `default`, `maximum`, `enum` | Refine the schema; on an array parameter they apply to its items. |
| `required` | Makes the parameter required. |

The same object may sit on the parameter definition; the operation's `params` entry wins per key.
A parameter that is excluded, `fixed` or the `response.selectParam` is not in the input schema.

### Request bodies

A tool sends one body the operation declares: `application/json` first, then
`multipart/form-data`, then a raw body of another media type (`text/csv`…), which is a file.
Other `+json` and form-urlencoded bodies are not sent. Multipart file parts and raw bodies are
[file inputs](#file-inputs).

- `body: flat` (default): an object body's properties are merged into the input schema; a name
  colliding with a parameter gets a `__body` suffix. A non-object JSON body is one `body` property.
- `body: compact`: one `body` property described by a compact listing (name, required, type,
  allowed values, short description), for a schema too large to put in a tool definition. The
  real schema validates the body before the request. JSON bodies only.
- `bodyFields`: an allow-list of body properties. The schema is pruned before the flat or compact
  choice, and any other property is refused. A property added to the API later is offered by no
  tool until an annotation names it.
- `bodyRequired`: properties this tool requires on top of the schema's, each one the tool offers.
  For an operation serving several purposes through one body: a view creating an article from a
  file requires the file part the operation declares optional, so the tool disappears with the
  file store rather than lose its file.

`bodyFields` and `bodyRequired` need an object body with declared properties, and do not apply to
an editor group.

### Responses

```yaml
response:
  rows: /results
  concise: [id, title, updatedAt]
  detailed: [id, title, summary, updatedAt]
  selectParam: select
  hints: /meta/hints
```

| Field | Effect |
| --- | --- |
| `rows` | Top-level key of the array of rows, as a pointer (`/results`), rendered as a markdown table. |
| `concise` | Fields of the default `response_format: concise`. |
| `detailed` | `true` (every field) or a field list, for `response_format: detailed`. With `concise`, generates the `response_format` parameter. |
| `selectParam` | The API's own projection parameter: a `fields` parameter is generated, its enum read from the response schema, which must declare properties. |
| `hints` | Pointer, through object keys, to a list of strings the API returns as advice, shown as `> Hint:` lines after the rest. |
| `file` | `true`: the response is a file, returned as a link. GET only, alone. See [File outputs](#file-outputs). |

A response is projected on the caller's `fields`, else its `response_format`, else `concise`, else
nothing. Strings are truncated (`maxStringLength`), except URLs and lists of URLs. An operation whose 2xx response
offers `text/markdown` is asked for it, and the body is passed through as is.

### Schema properties

On a response schema property, `hint` is a localized note shown next to the field, and
`exclude: true` drops the property at every depth, from rendering and from `fields` enums.

## Loading

```ts
const toolSet = await load(docOrUrl, {
  fetch,                // upstream requests, the document and skill bodies (default: globalThis.fetch)
  locale: 'en',
  baseUrl,              // default: servers[0].url
  documentUrl,          // base of relative skill links for a document passed as an object
  skillBodies,          // (url) => { text } | { error }: how linked skill bodies are read
  structuredContent: false,
  maxStringLength: 500, // rendered strings
  maxErrorLength: 4000, // HTTP error bodies
  lint: 'error',        // 'error' | 'warn' | 'off'
  files: { urlPrefixes, maxSize, timeout }, // see File inputs
  prepareEditorSchema   // (schema) => schema: see editor tool groups
})
```

`load` validates the vocabulary, inlines the refs the document resolves itself, checks every
annotation, then builds the tools. A ref resolves against the nearest embedded schema with an
`$id`, then the document root; `<uri>#/…` resolves against the schema declaring that `$id`. A ref
it cannot resolve reads as `{}` and is listed on the console, except under a `security` list,
where `{}` would be public: there the operation is refused.

A finding attributable to one operation (its annotation, its parameters, its request and response
schemas, the tool it would build) depends on `lint`:

- `'error'` (default) fails the document;
- `'warn'` leaves the operation out, with all its views, and prints why;
- `'off'` leaves it out silently.

A skill stops listing the tools left out. Findings elsewhere (root, tags, path-level parameters,
shared schemas, two tools with one name) fail the document at every level. Leaving out rather than
ignoring is deliberate: an ignored key could change what a tool does. Authoring and CI run with
`lint: 'error'`.

`lint` also checks the descriptions an annotation authored against their schema, since an agent
follows the description and the schema refuses what disagrees: a quoted scalar example for an array
parameter, "comma-separated" for an array parameter, a quoted value outside the enum. `'error'`
refuses the tool set listing every finding, `'warn'` prints them, `'off'` skips the check.

## Files

A tool takes a file as a URL and returns one as a link: file bytes never pass through the model or
the MCP protocol.

### File inputs

File inputs are indirect uploads: the caller puts the file in its store, signs a short-lived GET
URL, and passes it; the server fetches it and streams it to the API. They are detected from the
document, with nothing to annotate:

- a multipart part with `format: binary`, or a `contentMediaType` without `contentEncoding`;
- a raw body: one input named `file` (`file__body` on a collision).

A part that is a list of files is not offered (an input carries one URL). Each file input is:

```json
{ "type": "string", "format": "uri", "description": "…", "x-mcp-file": { "accept": ["text/csv"], "maxSize": 104857600 } }
```

`accept` comes from the part's `encoding.<part>.contentType`, its `contentMediaType` or the raw
body's media types (`application/octet-stream` is left out). `x-mcp-file` is the keyword of the
MCP file input proposals (SEP-2356, SEP-2631); `contentMediaType` would say the string is the
bytes.

`files.urlPrefixes` names the store (its endpoint and bucket path). Without a prefix, file inputs
are off: optional file parts disappear, and a tool needing a file is not offered. At execution:

- **Only the store.** A URL is fetched when, normalized, it starts with a prefix at a boundary
  (`…/bucket` admits `…/bucket/a.csv`, never `…/bucket-evil/a.csv`). Anything else is refused
  before connecting.
- **No credentials.** A plain GET, without the call's context: a presigned URL authorizes itself.
  Behind a credential-injecting proxy, keep the store in `NO_PROXY`.
- **No redirect, no encoding.** A 3xx is an error. A `Content-Encoding` other than `identity` is
  refused: those bytes are not the file.
- **Bounds.** `files.maxSize` (100 MiB) is checked against `Content-Length` before reading, and the
  bytes read must match it. `files.timeout` (300 s) runs to the last byte.
- **Exact length.** The upload is streamed with its `Content-Length`, never chunked, so a source
  without `Content-Length` is refused.
- **Name.** The URL's last path segment, decoded, extension included.
- **Multipart.** Fields first, then files. An object or array field is sent as JSON, a scalar as its
  string. A file part's `Content-Type` is the source's, else the first accepted type.
- **Errors** name the input and the URL without its query string, which may carry a signature.

### File outputs

`response: { file: true }` on a GET says its response is a file. A parameter choosing the format is
pinned with `fixed`:

```yaml
get:
  operationId: exportArticle
  x-agent: { name: export_article, fixed: { format: pdf }, response: { file: true } }
```

The tool sends no request: it builds the URL a call would use and returns a `resource_link`, with
a text block for clients that ignore links. The client fetches it with its own credentials.

- `mimeType`: the declared response media type; among several, the one a `format` query value
  names by extension; else none.
- `name`: the last path parameter's value and the segments after it
  (`/articles/{id}/export` → `<id>-export`), with the extension of `mimeType` when it has none.

A file output cannot carry header parameters: exclude them.

## Not in the vocabulary

Templates, hooks, executable composition and codegen. `x-agent` describes an API to an agent; it
adds no behaviour. An annotation names another operation only for an editor group, which has to
say where its document and schema come from.
