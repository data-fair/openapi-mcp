# openapi-mcp

Turns an OpenAPI document annotated with a custom `x-agent` extension into MCP tools for AI agents. Use it as a library to build a tool set from a spec and wire it into any MCP server, or run the bundled standalone binary to serve a spec directly over stdio or HTTP.

## Library

```ts
import { load } from '@data-fair/openapi-mcp'
import { createMcpServer } from '@data-fair/openapi-mcp/adapters/mcp'

const toolSet = await load('https://example.com/openapi.json', { profile: 'explore' })
const server = createMcpServer(toolSet, { name: 'my-api', version: '1.0.0' })
// server.connect(transport) with any @modelcontextprotocol/sdk transport
```

## Standalone server

The package also installs an `openapi-mcp` binary that reads its configuration from the environment:

| Env var           | Required | Default | Description                                                    |
| ------------------ | -------- | ------- | ---------------------------------------------------------------- |
| `OPENAPI_URL`       | yes      |         | URL of the OpenAPI document to load                              |
| `PROFILE`           | no       |         | `x-agent` profile to select                                      |
| `LOCALE`            | no       | `en`    | Locale used to resolve localized text                            |
| `BASE_URL`          | no       |         | Overrides `servers[0].url` from the document                     |
| `TRANSPORT`         | no       | `stdio` | `stdio` or `http`                                                 |
| `PORT`              | no       | `8080`  | Port to listen on when `TRANSPORT=http`                           |
| `API_KEY_HEADER`    | no       |         | Header name added to every upstream request                      |
| `API_KEY`           | no       |         | Value sent in `API_KEY_HEADER`                                   |
| `STRUCTURED_CONTENT`| no       | `false` | Set to `true` to also return `structuredContent` from tool calls |

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

See [`docs/superpowers/specs/2026-09-19-openapi-mcp-design.md`](docs/superpowers/specs/2026-09-19-openapi-mcp-design.md) for the `x-agent` vocabulary.

Experimental — phase 1 (core) of the design.

## Evaluating

An eval harness compares this project's annotation-derived tools against the hand-written
`data-fair/mcp` tool set on the same scenarios, judged blind to which arm produced each
transcript. Design and results: [`docs/superpowers/specs/2026-09-19-eval-harness-design.md`](docs/superpowers/specs/2026-09-19-eval-harness-design.md).

```bash
npm run eval:run     # runs every scenario against both arms
npm run eval:judge    # judges each transcript, blind to arm
npm run eval:report   # prints the comparison table and totals
npm run eval           # all three, in order
```

`OPENAPI_MCP_EVAL_MODEL` (default `haiku`) picks the runner model; `OPENAPI_MCP_EVAL_JUDGE_MODEL`
(default `sonnet`) picks the judge model. `DATA_FAIR_MCP` points at the sibling
`data-fair/mcp` checkout used for arm A (default `~/data-fair/mcp`).

This costs money (runner + judge model calls) and hits a live public data-fair instance —
it is not run in CI. The first full run (22 scenario x arm runs plus 22 judge calls) cost
about **$1.10** total (runner on `haiku` plus judging on `sonnet`). `eval:judge` has no
skip-if-already-judged check — it re-judges every transcript in `evals/runs/` on every
invocation, so re-running it (e.g. after a partial `eval:run`) re-bills all of them, not
just the new ones. See `evals/baselines/2026-09-21/` for the newest baseline.
