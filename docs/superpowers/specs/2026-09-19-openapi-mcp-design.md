# openapi-mcp — design

*2026-09-19. Experimental; not aiming for production yet.*

## Thesis

API documentation is declarative and always up to date; hand-written MCP tools drift. But
agents given a generic HTTP client lose the edge that tailored tools have: short
descriptions, sensible defaults, excluded noise, shaped responses, workflow guidance.
This library turns an OpenAPI document annotated with a small `x-agent` vocabulary into
targeted tools, at runtime, so the API owner curates once inside the spec and every
consumer (MCP server, AI SDK agent, WebMCP page) gets the same tools.

The quality question the project exists to answer: can annotations alone produce tools
as good as `data-fair/data-fair/agent-tools` (hand-written, evaluated) for catalog
exploration? The parity evaluation (section 7) answers it and lists what refuses to be
declarative.

## Landscape (September 2026)

Nothing to build on; two things to borrow.

- Generators: FastMCP (`RouteMap`, `MCPType.EXCLUDE`, `mcp_component_fn`; its own docs
  say curated servers beat auto-converted ones), Speakeasy (`x-speakeasy-mcp:
  {name, description, scopes}`, jq response filtering), Stainless (per-client schema
  adaptation, `jq_filter`, now recommends "SDK code mode"), openapi-mcp-generator (codegen,
  `x-mcp: true|false`), mcp-from-openapi (profiles with allow/deny, field trimming,
  aliasing, composites), oapi-invoker-mcp (`x-filter-rules`, `x-response-config`,
  `x-tree-shaking-func`).
- Conventions: none standard. OpenAPI Overlays with `x-mcp-tool-name`/`x-agent-hint` is
  the emerging "enrich for agents separately" pattern; `x-agent-trust` (OAI registry) is
  about auth trust levels; Arazzo is the formal workflow answer, judged too heavy.
- Platform: MCP 2026-07-28 lifts input/output schemas to full JSON Schema 2020-12,
  `structuredContent` may be any value, annotations stay at five hints. Anthropic's tool
  search / `defer_loading` makes discovery a platform feature (>10 tools → search).
- Evidence on output format: content matters more than syntax (strip low-level ids,
  resolve ids to names, defaults, `response_format: concise|detailed`); markdown tables
  match JSON accuracy on flat rows at ~38 % of the tokens; format effects are dwarfed by
  model capability; MCP clients substitute `structuredContent` for text (json-layout:
  91 KB → 2 KB per call once structured output was dropped).
- Evidence on agent-chosen filtering: `jq_filter` ships (Stainless, Speakeasy) without
  published misuse data; Anthropic's answer is programmatic tool calling (filter in code,
  37 % fewer tokens, higher accuracy) and `input_examples` (72 % → 90 % on complex params).

Borrowed: Speakeasy's single-object extension shape; oapi-invoker's response config idea,
reduced to projection presets.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Where annotations live | In the source spec, emitted by the API (`x-agent`, like data-fair's existing `x-permissionClass`) | The only path that stays in sync, and the only one that can annotate data-fair's dynamic per-dataset docs |
| Third-party APIs | Out of scope | No annotations → no tools; IGN geocoding stays a hand-written tool |
| First target | data-fair root doc (`/api/v1/api-docs.json`), `explore` profile | Apples-to-apples with today's MCP server and its evals; per-dataset doc is the second target |
| Response shaping | Projection presets + generic schema-driven renderer | Measured wins come from content, not templates; templates and hooks rejected until the eval proves a gap |
| Agent-chosen fragments | Constrained `fields` enum (from the response schema, mapped on the API's own projection param when it has one) and `response_format` preset; no jq | Validated input, output still matches the schema, no syntax to get wrong |
| Tool selection | Opt-in with profiles | The annotation is the curation; one spec serves a 7-tool portal agent and a 20-tool back-office agent |
| Composition | None executable; skills are text | An operation referencing others is a workflow language through the back door; if a round-trip is too costly the API should grow the feature (`?samples=3`) |
| Generation | Runtime from a spec URL or object; no codegen | Freshness is the point |
| Credentials | Caller-supplied `fetch` | API key, session cookie, NHI bearer, reverse-proxy headers all live outside the lib |

## 1. Shape

TypeScript ESM library `@data-fair/openapi-mcp`, same toolchain as `data-fair/mcp` and
`data-fair/agents`.

```
load(specUrlOrDoc, { profile, fetch, locale, baseUrl? })
  → ToolSet                              // provider-agnostic
      { instructions: string, tools: Tool[] }
      Tool = { name, title, description, inputSchema, outputSchema?, annotations,
               examples?, execute(params) → { text, structuredContent?, isError? } }
  → adapters
      toMcpServer(toolSet, server)       // @modelcontextprotocol/sdk McpServer
      toAiSdkTools(toolSet)              // Vercel AI SDK `tool()` map (agents)
      toWebMcp(toolSet)                  // navigator.modelContext descriptors
```

A standalone MCP server binary (`OPENAPI_URL`, `PROFILE`, stdio or http) wraps `load` +
`toMcpServer`; it is the intended replacement for `data-fair/mcp`'s hand-written server.

Non-goals: unannotated APIs, executable workflows, codegen, OpenAPI 2.x, credentials.

## 2. Vocabulary

One key, `x-agent`, an object, validated by its own JSON schema; unknown fields or wrong
shapes fail `load` loudly. Any agent-facing string is a plain string or a locale map
`{ fr, en }`; `load({ locale })` picks, falling back to the first entry. Everything else in
the spec stays for humans; `x-agent` replaces it for agents only where present.

**Root**
- `namePrefix` — tool name prefix (`datafair_`).
- `profiles` — `{ explore: { title, description }, edit: {…} }`; the first declared is the
  default.
- `skills` — `[{ name, description (markdown), profiles?, tools? }]`. Text only. Rendered
  into MCP `instructions`; adapters may also expose them as MCP prompts or a
  system-prompt section. Today's `filtersGuide` and server instructions become skills.

**Tag** (`tags[].x-agent`)
- `profiles` — default for operations carrying the tag.
- `skill` — a section of the instructions for that group.

**Operation** (presence = opt-in)
- `profiles` — `string[]` or `true` (all).
- `name` (default: snake_case `operationId`), `title`, `description`, `examples`
  (→ `input_examples`), `annotations` (MCP hints; defaults: `readOnlyHint` for GET/HEAD,
  `destructiveHint` for DELETE).
- `params` — `{ [paramName]: { name?, description?, exclude?, default?, maximum?,
  enum?, required? } }`. The same object may sit directly on a parameter definition
  (data-fair spreads shared params, so a default there applies everywhere); the operation
  form wins on conflict.
- `fixed` — `{ [paramName]: value }` sent on every call, never exposed.
- `response` — `{ rows?: jsonPointer, concise?: field[], detailed?: true | field[],
  selectParam?: paramName, hints?: true }`. `concise`/`detailed` are projection presets;
  when both exist a `response_format` enum param is generated (`concise` default).
  `selectParam` generates a `fields` param whose enum comes from the response schema and
  maps it onto the API's native projection param. `hints` surfaces `meta.hints`-style
  arrays as footnotes.

**Schema property**
- `hint` — rendered as a note wherever the field appears.
- `exclude` — dropped from rendering.

Example, `readLines`:

```yaml
x-agent:
  profiles: [explore]
  name: search_data
  description: Retrieve rows matching filters/text. Not for statistics — use aggregate_data.
  params:
    size: { maximum: 100, default: 12 }
    qs: { exclude: true }
    highlight: { exclude: true }
    format: { exclude: true }
  response: { rows: /results, selectParam: select, hints: true }
  examples:
    - { datasetId: abc, filters: { ville_eq: Paris, age_gte: "30" }, size: 5 }
```

Not in the vocabulary: templates, hooks, composition, jq.

## 3. Execution

**Input schema.** Flat object: path + query + header params after overrides, plus request
body properties merged at top level (a single `body` property when the body is not an
object; a colliding name gets a `__body` suffix). `fixed` params removed. Generated
params: `fields`, `response_format`. `$ref`s inlined; `oneOf` and `patternProperties`
(data-fair's filters object) pass through — MCP 2026-07 and the AI SDK's `jsonSchema()`
accept them.

**Request.** Path params URL-encoded; query params serialized per `style`/`explode`
(data-fair: `form`, `explode: false`); objects with `patternProperties` spread as
individual query params; `undefined` omitted, `""` kept; JSON body. A standard `Request`
goes to the caller's `fetch`; base URL from `servers[0]` unless overridden.

**Rendering.** Text-only by default; `structuredContent` only when the adapter is told
the client wants it. Steps: projection (`fields` > `response_format` > `concise` >
nothing); drop `exclude` properties; `rows` array → markdown table in projection order,
hinted columns get a `> note` under the table; remaining object → key/value lines, nested
objects as compact indented YAML-like text, never raw JSON; long strings truncated with a
marker at a configurable limit; `hints` → `> Hint:` lines; a `next`-style field kept
verbatim and labelled. Non-JSON text responses pass through; binary responses are
excluded at `load` with a warning.

**Errors.** Non-2xx → `isError: true`, text `HTTP <status>: <body, truncated>` — verbatim,
because data-fair's 400 bodies list a column's valid operations and are the agent's
self-correction channel. Network errors and timeouts likewise. No retries.

## 4. Testing

Unit tests (node test runner, TypeScript), no network:
- vocabulary schema fixtures; opt-in / profile / tag inheritance;
- input derivation: params, body merge, rename/exclude/fixed, generated params;
- serialization matrix (`style`/`explode`, filters spreading, encoding);
- renderer golden files (response + schema + annotations → markdown);
- adapters round-trip a mocked `fetch`;
- integration fixture: a frozen copy of data-fair's root `api-docs.json` with
  hand-added `x-agent` annotations; `load` yields the expected `explore` tools and each
  schema is diffed against today's `agent-tools` schema.

## 5. Parity evaluation

Scenarios copied from `data-fair/mcp/evals/scenarios.json` (French questions against
opendata.koumoul.com), run through:
- A — today's hand-written `data-fair/mcp` server;
- B — the standalone binary on the annotated root doc, `explore` profile.

Harness in `evals/`: an AI SDK loop with a pinned model (haiku by default, opus to
confirm), saved transcripts, an LLM judge reading transcripts, per-run metrics: pass/fail,
tool calls, total tokens, tool-definition tokens, tool errors. Success: B passes the same
scenarios at ≤ 1.2× tokens. Every failing scenario gets a written explanation of which
`formatResult` behaviour it exposes; that list decides whether hooks are ever added.

## 6. data-fair side

Separate PR, after phase 1: `api/contract/*-api-docs.ts` emits `x-agent` on the root doc
and on `listDatasets`, `readDescription`, `readLines`, `getValues`, `getValuesAgg`,
`getMetricAgg`; instructions and `filtersGuide` move to root `skills`; `hint` on
`_geopoint`/`_geocorners` and enum-bearing columns. Until then this repo's frozen
annotated copy is both fixture and eval input.

## 7. Phasing

1. Core: vocabulary, `load`, input derivation, serialization, renderer, `toMcpServer`,
   binary; unit tests; frozen fixture.
2. Eval harness; parity run; gap list.
3. AI SDK and WebMCP adapters; `agents` consumes the lib.
4. data-fair emits annotations; `data-fair/mcp` switches to the binary; per-dataset doc
   as second target.

Only phase 1 is planned now.

## Layout

```
src/
  vocabulary/   x-agent JSON schema, validation, profile/tag resolution
  load.ts       spec fetch/parse, $ref resolution, ToolSet construction
  input.ts      inputSchema derivation
  request.ts    serialization → Request
  render.ts     projection + markdown renderer
  adapters/     mcp.ts, ai-sdk.ts, webmcp.ts
  bin/          standalone MCP server
test/           fixtures/ (annotated data-fair root doc, golden renders)
evals/          scenarios.json, harness, baselines/
docs/superpowers/specs/
```
