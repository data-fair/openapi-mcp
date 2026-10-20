# openapi-mcp

Turns an OpenAPI document annotated with a custom `x-agent` extension into MCP tools for AI agents. Use it as a library to build a tool set from a spec and wire it into any MCP server, or run the bundled standalone binary to serve a spec directly over stdio or HTTP.

- **Annotation reference:** [`docs/x-agent.md`](docs/x-agent.md) — every key of the vocabulary.
- **Form tools:** [`docs/editor-tool-groups.md`](docs/editor-tool-groups.md) — turn a write operation into eight json-layout editing tools.

## Install

```sh
npm install @data-fair/openapi-mcp
```

## Library

```ts
import { load } from '@data-fair/openapi-mcp'
import { createMcpServer } from '@data-fair/openapi-mcp/adapters/mcp'

const toolSet = await load('https://example.com/openapi.json')
const server = createMcpServer(toolSet, { name: 'my-api', version: '1.0.0' })
// server.connect(transport) with any @modelcontextprotocol/sdk transport
```

One document in, one tool set out: every operation carrying `x-agent` is a tool, named
`x-agent.name`, else the snake_case of its `operationId`. `load` returns
`{ instructions, tools, skills }` — provider-agnostic tools, each with an
input schema, a description, MCP annotations, its `security` and an `execute(params)` that returns
`{ text, structuredContent?, resourceLink?, isError? }` and never throws. `toMcpServer(toolSet, server)`
registers them on an existing SDK `Server` if you already have one.

## Standalone server

The package also installs an `openapi-mcp` binary that reads its configuration from the environment:

| Env var             | Required | Default | Description                                                                      |
| ------------------- | -------- | ------- | -------------------------------------------------------------------------------- |
| `OPENAPI_URL`       | yes      |         | URL of the OpenAPI document                                                      |
| `LINT`              | no       | `error` | `error`, `warn` or `off` — see Annotation lint                                   |
| `LOCALE`            | no       | `en`    | Locale used to resolve localized text                                            |
| `BASE_URL`          | no       |         | Overrides `servers[0].url` from the document                                     |
| `TRANSPORT`         | no       | `stdio` | `stdio` or `http`                                                                |
| `PORT`              | no       | `8080`  | Port to listen on when `TRANSPORT=http`                                          |
| `API_KEY_HEADER`    | no       |         | Header name added to every upstream request                                      |
| `API_KEY`           | no       |         | Value sent in `API_KEY_HEADER`                                                   |
| `STRUCTURED_CONTENT`| no       | `false` | Set to `true` to also return `structuredContent` from tool calls                 |
| `FILE_URL_PREFIXES` | no       |         | Comma-separated URL prefixes of the file store whose presigned URLs file inputs take; unset: file inputs off |
| `FILE_MAX_SIZE`     | no       | `104857600` | Largest file a file input accepts, in bytes                                   |
| `FILE_TIMEOUT`      | no       | `300`   | Seconds to fetch a file input, first request to last byte                         |

`INDEX_URL`, `PROFILES` and `PROFILE` were removed in 0.7.0: the binary refuses to start when
one is set (`unknown variable …`) rather than serve another surface than the one asked for.
HTTP mode here is single-identity and stateless: it is for development. A deployed server that
serves several callers forwards each caller's identity per call through the adapter's
context hook — that is `data-fair/mcp` v2, not this binary.

### Coding agents behind nhi-proxy

Identity comes from the environment; the binary implements nothing for it:

```sh
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7331 \
NODE_EXTRA_CA_CERTS=~/.config/nhi-proxy/koumoul.com/ca.crt \
OPENAPI_URL=https://koumoul.com/data-fair/api/v1/platform/api-docs.json openapi-mcp
```

`API_KEY_HEADER` + `API_KEY` are a single-credential convenience for standalone use. Anything richer (OAuth, multiple headers, per-request auth) is done in code with the library's `fetch` option.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": ["-y", "@data-fair/openapi-mcp"],
      "env": { "OPENAPI_URL": "https://example.com/openapi.json" }
    }
  }
}
```

## One document

A deployment publishes one document; `load` turns it into one tool set. Keeping it current is
the server's business: the library runs no timer and caches nothing between calls. A server that
reloads passes the tool set per request and tells its clients when it changed:

```ts
import { load, toolsForScopes } from '@data-fair/openapi-mcp'
import { createMcpHttpHandler } from '@data-fair/openapi-mcp/adapters/mcp'

let toolSet = await load('https://host/data-fair/api/v1/platform/api-docs.json', { locale: 'fr' })
const handler = createMcpHttpHandler((request) => toolsForScopes(toolSet, scopesOf(request)), { name: 'my-server', version: '1.0.0' }, {
  context: (request) => ({ headers: { cookie: request?.headers.get('cookie') ?? '' }, identity: request?.headers.get('cookie') ?? undefined }),
  cacheTtlMs: 300_000 // advertised as `ttlMs`: how long a client may keep a listing
})
// after a reload that changed something:
toolSet = reloaded
handler.notify.toolsChanged()
handler.notify.resourcesChanged()
```

`load`'s `skillBodies` option is where a server plugs its own cache of linked skill bodies, and
`toolSetSnapshot` tells a reload that changed something from one that only fetched new bytes.

A document assembled from several services carries schemas written for each of them. `load`
inlines every `$ref` the document resolves itself: `#/…` against the nearest embedded schema
resource (a schema with a `$id`) and then the document root, `<uri>#/…` against a schema of the
document declaring that `$id`. A ref it cannot resolve — a URL or file it does not embed, a missing
target, an anchor — reads as `{}` (any value) and is listed on the console (unless `lint: 'off'`);
it never fails the document, so one service's schema detail cannot take every tool down. Under a
`security` list `{}` would be the public alternative, so there the ref stays as written and the
security check refuses the operation instead.

## Scopes

Each tool carries the security of its operation as `tool.security`: the OpenAPI alternatives, the
document's root `security` applied when the operation declares none, `undefined` when neither
does. `toolsForScopes(toolSet, scopes)` is the part of a tool set a token with these OAuth scopes
can use:

```ts
import { toolsForScopes } from '@data-fair/openapi-mcp'

const scoped = toolsForScopes(doc.toolSet, ['datasets:read', 'applications:read'])
```

A tool is kept when one alternative is met: an `oauth2` requirement whose scopes the token holds
every one of (exact membership: list each scope an operation accepts, umbrella included, as an
alternative of its own), or a public one (`{}`, or `security: []`). An operation with no security
at all is not public here: it is left out. Only a scheme named `oauth2` grants: an alternative
under another name (`apiKey`, a cookie, an `openIdConnect` scheme) never keeps a tool for a scoped
token. `{ oauth2: [] }` asks for no scope, so any scoped token meets it, even one with an empty
list. `scopes` undefined is an unscoped session, and keeps every tool. A security that is not a
list of requirements (scheme name → scope list) is refused at load, like a bad annotation. Skills whose `tools` were all left out go with them; the instructions are rebuilt.

One operation can serve several tiers. A view's `security` narrows its operation's for that tool:

```yaml
patch:
  operationId: patchDataset
  security: [{ apiKey: [] }, { oauth2: [datasets:write] }, { oauth2: [datasets:admin] }, { oauth2: [datasets] }]
  x-agent:
    - { name: update_dataset, bodyFields: [title, description] }
    - { name: publish_dataset, bodyFields: [publicationSites], security: [{ apiKey: [] }, { oauth2: [datasets:admin] }, { oauth2: [datasets] }] }
```

A `datasets:write` token is offered `update_dataset` and not `publish_dataset`, which the API would
refuse it. An entry can only drop alternatives: one the operation does not declare is refused
(`publish_dataset: x-agent security alternative {"oauth2":["datasets:read"]} is not in the operation's security`),
and so is an entry `security: []` on an operation that is not public itself.

## Identity per call

`Tool.execute(params, ctx)` takes a `CallContext` — `fetch`, `headers`, `signal`,
`identity`. The library never reads a cookie or holds a credential: a server derives the
context from the request it serves, a page passes its own `fetch`, the binary relies on the
environment. `identity` partitions json-layout editor sessions per caller.

## Skills

Skills follow the Agent Skills disclosure levels. The MCP `instructions` list each selected skill
by name and description, with the resource to read; bodies never go there. A body is served as
`skill://<service-id>/<name>/SKILL.md` through `resources/read`, and through the skills extension
(`io.modelcontextprotocol/skills`: `skills/list`, `skills/get`, with a SHA-256 manifest).

A client that declares the skills extension in its `initialize`
(`capabilities.extensions['io.modelcontextprotocol/skills']`) lists skills itself with `skills/list`,
so its `instructions` carry the guides only, without the skill entries. A skill that names tools
carries them in its frontmatter as `metadata.tools` (space-separated), so a host can hide a skill
whose tools it filtered out without reading its body.

A body is inline (`body`) or linked (`href`, a markdown file next to the document). `load()` reads
linked bodies with its `fetch`, or with the `skillBodies` function it is given. A body that cannot be read keeps the skill listed: its resource answers the
error, the binary prints a warning, and the skills manifest leaves it out.

### Upgrading to 0.7.0

One document in, one tool set out.

- Removed: profiles (`load`'s `profile` and `profiles` options, `x-agent.profiles` at the root, on
  tags, operations and skills), `namePrefix` (root annotation and option), the composer
  (`createComposer`, `compose`, `ProfileInfo`, `ServiceStatus`) and the deployment index. The
  vocabulary refuses `profiles` and `namePrefix` wherever they appear.
- A tool is named `x-agent.name ?? snake_case(operationId)`, nothing prepended. A deployment of
  several services merges them into one document, whose entries carry their final names.
- Who sees a tool is now the token's business: tools carry their `security`, an entry may narrow
  it, `toolsForScopes` filters (see Scopes). Goldens gain each tool's `security`.
- The binary: `OPENAPI_URL` is required and loaded once; restart it to pick up a change.
  `INDEX_URL`, `PROFILES`, `PROFILE` and `REFRESH_INTERVAL` stop it with `unknown variable …`.
- Nothing refreshes a document any more: a server that reloads one calls `load` again (see One
  document). The MCP adapter takes a tool set or a function returning one per request, and its
  `refreshMs` option is now `cacheTtlMs`; it no longer publishes change notifications itself,
  `handler.notify` does. `resolveToolSet` and the `ToolSource` type are gone.

### Upgrading to 0.4.0

A skill's `description` is now at most 1024 characters and is never split into paragraphs. Move a
long text to `body` (or to a file served next to the document, referenced by `href`) and write a
one- or two-sentence `description`. The instructions now list skills instead of embedding them,
and golden snapshots gain each skill's `digest`.

## Per-service golden

`toolSetSnapshot(toolSet)` is the agent-facing surface as plain data. A service's CI loads
its own document with `lint: 'error'` and diffs the snapshot against a committed golden, so a
change to a tool's name, description, schema or security is a reviewable diff in the pull
request that caused it. The tool names `toolsForScopes` keeps for each scope set worth
checking make a short second golden.

## Editor tool groups

Annotate a write operation with `editor` and it becomes eight json-layout form tools —
`describeState`, `getData`, `setData`, `setFieldValue`, `getFieldSuggestions`,
`editArray`, `saveForm`, `reloadForm` — instead of one opaque body-submitting tool. A
session per record loads the current document, validates every edit, and saves the whole
document when it is valid.

```yaml
put:
  operationId: updateLine
  x-agent:
    name: dataset_line
    editor:
      schemaOperation: readSchema
      schemaParams: { mimeType: application/schema+json }
      readOperation: readLine
```

`@json-layout/agents` and `@json-layout/core` are optional peers, imported lazily and
needed only when an editor annotation is present. See
[`docs/editor-tool-groups.md`](docs/editor-tool-groups.md) for the annotation, the tool
surface, schema preprocessing and limitations.

## Large request bodies

A write operation's request body schema can be far too large to put in a tool definition —
data-fair's dataset body is 28 KB, roughly twice its entire six-tool read set. Annotate the
operation with `body: compact` and the tool exposes a single `body` property described by a
compact listing (name, required, type, allowed values, a short description) instead of
merging the schema's properties at top level.

The real schema still validates the body before a request is sent, so a caller that
misreads the listing gets a JSON path and a keyword locally rather than a round trip.
`body: flat`, the default, keeps the previous behaviour.

## Files

Upload operations take a file as a URL, and `response: { file: true }` operations return one as
an MCP `resource_link`: file bytes never pass through the model or the MCP protocol. File inputs
are indirect uploads. They are detected from the OpenAPI document (multipart `format: binary` /
`contentMediaType` parts, raw `text/csv`-style bodies) and marked `x-mcp-file`. The server
fetches only the presigned URLs of the file store named by `FILE_URL_PREFIXES` (unset: operations
that need a file — a required file part, raw body or list of files — are not offered, and optional
file parts disappear from their tool), without the caller's credentials, and streams them upstream with an exact
`Content-Length`. Behind a credential-injecting proxy (`NODE_USE_ENV_PROXY`), keep the file store in
`NO_PROXY`: see [`docs/x-agent.md#files`](docs/x-agent.md#files).
An optional file part that a tool cannot do without is made required for that tool with the
view key `bodyRequired`, so the tool disappears with the file store rather than lose its file.

## Annotation lint

`load` checks that a description an annotation authored still agrees with the schema it
describes — a description promising a scalar for a parameter whose schema is an array gets
the agent rejected before any request is sent. Descriptions inherited from the OpenAPI
document are not linted: they belong upstream.

A disagreement refuses the tool set by default, listing every one at once. Pass
`lint: 'warn'` to print and continue, or `lint: 'off'` to skip the check. Under `warn` and `off`,
an operation whose `x-agent` this version does not accept is left out (the rest loads): see
Forward compatibility in docs/x-agent.md.

## Coding agent skill

A skill that teaches coding agents to write and review `x-agent` annotations lives in
[`skills/openapi-mcp`](skills/openapi-mcp/SKILL.md). Install it into a project with:

```sh
npx skills add data-fair/openapi-mcp
```

## Contributing

Development commands, the evaluation harness and the release process are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

AGPL-3.0-only
