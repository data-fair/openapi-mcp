# openapi-mcp

Turns an OpenAPI 3.x document annotated with `x-agent` into MCP tools for AI agents. An operation
becomes a tool only when it carries `x-agent`; the annotation says what the tool is called, what an
agent sees of its input and output, and which skills and guides come with it.

- [`docs/x-agent.md`](docs/x-agent.md): the annotation reference.
- [`docs/editor-tool-groups.md`](docs/editor-tool-groups.md): a write operation as eight form tools.
- [`skills/openapi-mcp`](skills/openapi-mcp/SKILL.md): a skill teaching coding agents to write
  annotations (`npx skills add data-fair/openapi-mcp`).

## Install

```sh
npm install @data-fair/openapi-mcp
```

## Library

```ts
import { load, toolsForScopes } from '@data-fair/openapi-mcp'
import { createMcpHttpHandler } from '@data-fair/openapi-mcp/adapters/mcp'

const toolSet = await load('https://example.com/openapi.json', { locale: 'en' })
const handler = createMcpHttpHandler(
  (request) => toolsForScopes(toolSet, scopesOf(request)),
  { name: 'my-api', version: '1.0.0' },
  {
    context: (request) => {
      const authorization = request?.headers.get('authorization')
      return authorization ? { headers: { authorization } } : undefined
    }
  }
)
```

`load(docOrUrl, options)` returns a tool set:

- `tools`: provider-agnostic tools, each with a name, a description, an input schema, MCP
  annotations, its `security` and `execute(params, ctx?)`, which never throws: a failure is
  `{ isError: true, text }`.
- `skills`: the document's skills (and one per editor group), served as `skill://<name>/SKILL.md`.
- `guides`: the instruction sections of the document's tags, each with the tools it is about.

The adapter (`@data-fair/openapi-mcp/adapters/mcp`) serves a tool set over MCP, both protocol eras,
with the skills extension:

- `createMcpHttpHandler(source, info, options)`: a fetch-style HTTP handler.
- `mcpServerFactory(source, info, options)`: a server per caller, for any SDK transport (stdio).
- `createMcpServer(source, info, options)`: one server.

`source` is a tool set or a function returning one per request. Options are `context`, which
derives a call's `CallContext` from the request, and `cacheTtlMs`, the `ttlMs` advertised on
listings (5 minutes by default). Keeping a tool set current is the server's job: when it replaces
one, it calls `handler.notify.toolsChanged()` and `handler.notify.resourcesChanged()`.

## Scopes

A tool carries its operation's security (the root `security` when the operation declares none).
`toolsForScopes(toolSet, scopes)` keeps the tools a token with these OAuth scopes can call, the
skills still driving one of them and the guides of their tags. An alternative grants when it is
public (`{}`, or `security: []`) or is an `oauth2` requirement whose scopes the token holds every
one of. Membership is exact, so an operation lists every scope it accepts as an alternative of
its own. Another scheme never grants, and an operation without any security is left out.
`scopes: undefined` keeps everything.

A view's `security` narrows its operation's for that tool: see
[Security](docs/x-agent.md#security).

## Identity per call

`Tool.execute(params, ctx)` takes a `CallContext`: `fetch`, `headers`, `signal`, `identity`. The
library holds no credential: a server derives the context from the request it serves.
`identity` keeps editor sessions apart per caller.

## Skills and guides

The MCP `instructions` list each skill by name and description, with the resource to read, then
the guides. Bodies never go there: a skill's body is read as `skill://<name>/SKILL.md`, or through
the skills extension (`skills/list`, `skills/get`). A client that declares the extension lists
skills itself, so its instructions carry the guides only.

A skill body is inline (`body`) or a markdown file linked by `href`, read with `load`'s `fetch`
or with its `skillBodies` option (a caller's cache). A body that cannot be read keeps the skill
listed, and reading it answers the error.

## Golden

`toolSetSnapshot(toolSet)` is the agent-facing surface as plain data: tools (name, description,
input schema, annotations, security), skills and guides. A service loads its own document with
`lint: 'error'` in CI and diffs the snapshot against a committed golden.

## Standalone server

The `openapi-mcp` binary loads one document at startup and serves it.

| Env var             | Default     | Description                                                              |
| ------------------- | ----------- | ------------------------------------------------------------------------ |
| `OPENAPI_URL`       | (required)  | URL of the OpenAPI document                                              |
| `TRANSPORT`         | `stdio`     | `stdio` or `http`                                                        |
| `PORT`              | `8080`      | Port for `TRANSPORT=http`                                                |
| `LOCALE`            | `en`        | Locale of localized text                                                 |
| `BASE_URL`          |             | Overrides `servers[0].url`                                               |
| `LINT`              | `error`     | `error`, `warn` or `off` (see [Loading](docs/x-agent.md#loading))         |
| `API_KEY_HEADER`    |             | Header added to every upstream request                                   |
| `API_KEY`           |             | Its value                                                                |
| `STRUCTURED_CONTENT`| `false`     | `true` also returns `structuredContent`                                   |
| `FILE_URL_PREFIXES` |             | Comma-separated URL prefixes of the file store; unset: file inputs off   |
| `FILE_MAX_SIZE`     | `104857600` | Largest file input, in bytes                                             |
| `FILE_TIMEOUT`      | `300`       | Seconds to fetch a file input                                            |

It serves one identity. Credentials come from the environment: `API_KEY_HEADER` and `API_KEY`, or
a credential-injecting proxy (`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=…`; keep the file store in
`NO_PROXY`).

```json
{ "mcpServers": { "my-api": { "command": "npx", "args": ["-y", "@data-fair/openapi-mcp"], "env": { "OPENAPI_URL": "https://example.com/openapi.json" } } } }
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

AGPL-3.0-only
