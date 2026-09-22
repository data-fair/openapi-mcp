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

const toolSet = await load('https://example.com/openapi.json', { profiles: ['explore'] })
const server = createMcpServer(toolSet, { name: 'my-api', version: '1.0.0' })
// server.connect(transport) with any @modelcontextprotocol/sdk transport
```

`load` returns `{ profiles, instructions, tools, skills }` — provider-agnostic tools, each with an
input schema, a description, MCP annotations and an `execute(params)` that returns
`{ text, structuredContent?, isError? }` and never throws. `toMcpServer(toolSet, server)`
registers them on an existing SDK `Server` if you already have one.

## Standalone server

The package also installs an `openapi-mcp` binary that reads its configuration from the environment:

| Env var             | Required | Default | Description                                                                      |
| ------------------- | -------- | ------- | -------------------------------------------------------------------------------- |
| `INDEX_URL`         | one of   |         | URL of a deployment index listing service-level OpenAPI documents                |
| `OPENAPI_URL`       | one of   |         | URL of a single OpenAPI document                                                 |
| `PROFILES`          | no       |         | Comma-separated profile set; the default profile otherwise                       |
| `REFRESH_INTERVAL`  | no       | `300`   | Seconds between conditional re-fetches of the index and documents; `0` disables  |
| `LINT`              | no       | `error` | `error`, `warn` or `off` — see Annotation lint                                   |
| `LOCALE`            | no       | `en`    | Locale used to resolve localized text                                            |
| `BASE_URL`          | no       |         | Overrides `servers[0].url` from the document                                     |
| `TRANSPORT`         | no       | `stdio` | `stdio` or `http`                                                                |
| `PORT`              | no       | `8080`  | Port to listen on when `TRANSPORT=http`                                          |
| `API_KEY_HEADER`    | no       |         | Header name added to every upstream request                                      |
| `API_KEY`           | no       |         | Value sent in `API_KEY_HEADER`                                                   |
| `STRUCTURED_CONTENT`| no       | `false` | Set to `true` to also return `structuredContent` from tool calls                 |

In HTTP mode a request's `?profiles=explore,edit` selects the set for that request. HTTP
mode here is single-identity and stateless: it is for development. A deployed server that
serves several callers forwards each caller's identity per call through the adapter's
context hook — that is `data-fair/mcp` v2, not this binary.

### Coding agents behind nhi-proxy

Identity comes from the environment; the binary implements nothing for it:

```sh
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7331 \
NODE_EXTRA_CA_CERTS=~/.config/nhi-proxy/koumoul.com/ca.crt \
INDEX_URL=https://koumoul.com/data-fair/api/v1/agents/index.json PROFILES=explore,edit openapi-mcp
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

## Composing a deployment

An index lists a deployment's service-level documents; `createComposer` merges them into
one tool set per profile set, over one document cache:

```ts
import { createComposer } from '@data-fair/openapi-mcp'
import { createMcpHttpHandler } from '@data-fair/openapi-mcp/adapters/mcp'

const composer = await createComposer('https://host/data-fair/api/v1/agents/index.json', { locale: 'fr' })
composer.profiles()                       // every declared profile, expanded, with the index's wording
const c = await composer.compose(['explore', 'edit'])
c.toolSet.tools                           // each operation once, index order then document order
c.services                                // [{ id, status: 'ok' | 'skipped' | 'error', tools, reason? }]
setInterval(() => composer.refresh(), 300_000)   // conditional GETs; the library runs no timer

const handler = createMcpHttpHandler(composer, { name: 'my-server', version: '1.0.0' }, {
  context: (request) => ({ headers: { cookie: request?.headers.get('cookie') ?? '' }, identity: request?.headers.get('cookie') ?? undefined })
})
```

The index is the one document this library dictates:

```json
{
  "version": 1,
  "services": [{ "id": "data-fair", "openapi": "https://host/data-fair/api/v1/api-docs.json" }],
  "profiles": { "full": { "title": "Full", "includes": ["explore", "edit"] } },
  "skills": [{ "name": "publishing-workflow", "description": "…", "profiles": ["edit"] }]
}
```

A failing service is excluded and reported; only a bad index throws. Tool names must be
unique across services (`namePrefix` is how); on a collision the later service is excluded.
A request naming a profile no service declares is an error, not an empty set.

## Identity per call

`Tool.execute(params, ctx)` takes a `CallContext` — `fetch`, `headers`, `signal`,
`identity`. The library never reads a cookie or holds a credential: a server derives the
context from the request it serves, a page passes its own `fetch`, the binary relies on the
environment. `identity` partitions json-layout editor sessions per caller.

## Skills

`x-agent.skills` (and an index's `skills`) are served as resources through the official
skills extension (`io.modelcontextprotocol/skills`): `skills/list`, `skills/get`, and
`resources/read` of `skill://<service-id>/<name>/SKILL.md`, with a SHA-256 manifest. Skill
names follow the Agent Skills format (`^[a-z0-9]+(-[a-z0-9]+)*$`). The same text still
renders into `instructions`, so clients without the extension lose nothing.

## Per-service golden

`toolSetSnapshot(toolSet)` is the agent-facing surface as plain data. A service's CI loads
its own document with `lint: 'error'` for every declared profile and diffs the snapshot
against a committed golden, so a change to a tool's name, description or schema is a
reviewable diff in the pull request that caused it.

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
    profiles: [write]
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

## Annotation lint

`load` checks that a description an annotation authored still agrees with the schema it
describes — a description promising a scalar for a parameter whose schema is an array gets
the agent rejected before any request is sent. Descriptions inherited from the OpenAPI
document are not linted: they belong upstream.

A disagreement refuses the tool set by default, listing every one at once. Pass
`lint: 'warn'` to print and continue, or `lint: 'off'` to skip the check.

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
