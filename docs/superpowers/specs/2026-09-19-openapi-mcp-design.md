# openapi-mcp — design

*2026-09-19. Experimental; not aiming for production yet.*

## Thesis

API documentation is declarative and always up to date; hand-written MCP tools drift. But
agents given a generic HTTP client lose the edge that tailored tools have: short
descriptions, sensible defaults, excluded noise, shaped responses, workflow guidance.
This library turns an OpenAPI document annotated with a small `x-agent` vocabulary into
targeted tools, at runtime, so the API owner curates once inside the spec and every
consumer (MCP server, AI SDK agent, WebMCP page) gets the same tools. Owning the
converter also lets json-layout's form-editing tools plug into write operations, which no
third-party generator could offer.

The quality question the project exists to answer: can annotations alone produce tools
as good as `data-fair/data-fair/agent-tools` (hand-written, evaluated) for catalog
exploration? The parity evaluation (section 5) answers it and lists what refuses to be
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
| Formatting escape hatch | Content negotiation: an operation that declares a `text/markdown` response is requested with that `Accept` and passed through untouched | Keeps rendering the API's responsibility, declared in the spec, instead of adding hooks to the converter |
| Editing complex payloads | Opt-in `editor` on a write operation exposes json-layout's form tools over the body schema plus a submit tool | Reuses the evaluated json-layout WebMCP tools; the reason to own the converter in the first place |
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
- `editor` — `true` or `{ readOperation?: operationId }`, on an operation with a
  JSON request body (typically PUT/PATCH/POST). The body schema, with its json-layout
  `layout` keywords when present, is compiled into a json-layout `StatefulLayout`, and the
  tool becomes a group: `<name>_describe_state`, `<name>_set_field_value`,
  `<name>_set_data`, `<name>_edit_array`, `<name>_get_field_suggestions`,
  `<name>_get_data` (json-layout's WebMCP tools, unchanged) plus `<name>_submit`, which
  performs the operation with the form's data once valid. `readOperation` names the GET
  that loads the current document before editing (PATCH/PUT); it is the one
  cross-operation reference in the vocabulary, tolerated because it declares a resource's
  read counterpart, not a workflow. The group's skill text is json-layout's form-filling
  guide.
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

**Content negotiation.** When an operation's 2xx response declares `text/markdown`
(or another `text/*` type flagged by the API as agent-oriented), the request carries an
`Accept` header preferring it and the body is passed through untouched: the API renders,
the converter does not. Projection params are still sent if the API declares them; the
generic renderer below is skipped. This is the last-resort answer to "this response does
not render well generically" — the API grows a markdown representation, the spec declares
it, no converter code is written.

**Rendering.** Text-only by default; `structuredContent` only when the adapter is told
the client wants it. Steps: projection (`fields` > `response_format` > `concise` >
nothing); drop `exclude` properties; `rows` array → markdown table in projection order,
hinted columns get a `> note` under the table; remaining object → key/value lines, nested
objects as compact indented YAML-like text, never raw JSON; long strings truncated with a
marker at a configurable limit; `hints` → `> Hint:` lines; a `next`-style field kept
verbatim and labelled. Non-JSON responses (any content type other than `application/json`,
binary included) pass through as text via `res.text()`, unexamined — phase 1 has no binary
handling and no refusal; see the Phase 1 gaps section.

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
3. AI SDK and WebMCP adapters; `agents` consumes the lib; `editor` tool groups over
   json-layout (first target: a dataset metadata PATCH with `readOperation:
   readDescription`).
4. data-fair emits annotations; `data-fair/mcp` switches to the binary; per-dataset doc
   as second target.

Only phase 1 is planned now.

## Phase 1 gaps

Parameter diff of the six `explore` tools (annotated frozen `data-fair-root.json`, 44
paths / 387 KB, fetched 2026-09-19) against `@data-fair/agent-tools-data-fair@0.6.4`,
tool by tool. "Choice" = the annotation deliberately renames/excludes/adds; "real gap" =
something `agent-tools` does that the vocabulary or the API document cannot express yet.

- `list_datasets extra: response_format` — choice: generated by the `concise`/`detailed`
  response preset; a superset of agent-tools' fixed single shape (`detailed` returns every
  field, `concise` is a subset of it).
- `describe_dataset extra: response_format` — choice: same mechanism, but the `detailed`
  claim needs a correction (caught in the fix wave): it does **not** cover every field
  `agent-tools`' hand-written `formatResult` exposes. `formatResult` synthesizes three
  fields that have no counterpart in the raw dataset schema and so cannot be projected out
  of it, however wide `detailed` is: `geolocalized` and `temporalDataset` (booleans derived
  from whether `bbox`/`timePeriod` are present) and `sampleLines` (3 real rows fetched with
  a separate call to the dataset's own `/lines` route, not read off the dataset document at
  all). `detailed` is a superset of the raw schema's own fields, which is still real
  parity — an agent can get every column's type/concept/enum — but "covers every field
  agent-tools exposes" overstated it. **Real gap**: none of these three are declarative
  projections; each needs either a computed/synthetic property in the vocabulary (not
  planned) or the API growing real fields (`geolocalized`, `temporalDataset` as actual
  dataset properties; `sampleLines` the API already effectively supports via `search_data`
  with `size: 3`, just not folded into `describe_dataset`'s own response).
- `search_data missing: page` — choice: excluded in favor of cursor pagination (`after`);
  data-fair's own param description calls `page` "pagination en profondeur" secondary to
  `after` on this route.
- `search_data missing: q, extra: query` — choice: renamed (`q` → `query`) to disambiguate
  full-text search from column filter keys in the flattened input schema.
- `search_data`: **not** using `response.selectParam` (real gap, corrected after review) —
  an earlier draft routed `select` through `response.selectParam: 'select'`, generating a
  `fields` enum from `responseFields(op.responseSchema, '/results')`, i.e. from the *root*
  document's `/datasets/{id}/lines` response schema. That schema is a synthetic
  documentation stub shared by every dataset in the root doc
  (`name, description, category, value, siret, image, document`) — data-fair generates it
  from a sample/example dataset, not from the real dataset being queried. The spec
  originally framed the resulting `fields` param as a capability win over agent-tools'
  free-text `select` (validated input vs. unvalidated). It was the opposite: an agent
  that follows this tool set's own `Workflow` skill (`describe_dataset` → learn a real
  column key → project with `fields`) was rejected for essentially every real dataset —
  reproduced directly: `search_data({ datasetId: <real>, fields: ['population'] })` →
  `Invalid parameters: /fields/0 must be equal to one of the allowed values`. **Real gap**:
  a `response.selectParam`-generated enum cannot express per-dataset columns when the
  *root* document's per-dataset schemas are synthetic stubs; it needs the *per-dataset*
  document (`/datasets/{id}/api-docs.json`), which carries the dataset's real column
  enums — already phase 4's second annotation target ("data-fair emits annotations... /
  per-dataset doc as second target"). Fixed here by removing `selectParam` from
  `readLines` entirely. Checked whether the raw `select` parameter has the same problem on
  its own: it does not — the document's `select` schema is
  `{ type: array, items: { type: string } }` with no `enum` at all (free text, same shape
  as `agent-tools`' comma-string `select`, just expressed as a JSON array instead of a
  comma-joined string), so it is exposed as-is (`search_data missing: select` is gone from
  the diff; `fields` no longer appears either). The vocabulary gap noted for `sort` above
  — no way to widen or clear an inherited, overly-restrictive `enum` — is the same gap that
  would be needed here if a future root-doc-only `selectParam` situation produced a bad
  enum instead of no enum at all.
- `search_data extra: after, missing: next` — choice, but with a real gap attached, and the
  `next` half of it was previously left out of this writeup even though the diff has
  recorded it since the first run. The API returns `next` (a full URL) and expects `after`
  (an integer cursor usually read out of that URL by an HTTP client following it) as input.
  We expose `after` because it is the documented query parameter, and `render.ts` renders
  `next` verbatim in tool output per design so the URL reaches the agent — but the `after`
  param's description is the raw, untranslated French text carried over from the OpenAPI
  document ("Pagination en profondeur...") since the annotation does not override it, and
  it does not explain that the value is the integer found in `next`'s query string. That is
  a description problem, fixable with an annotation override. `missing: next` is a
  different, structural loss: `agent-tools`' `searchData` exposes `next` itself as an
  *input* parameter — an agent pastes the whole URL a previous response returned back into
  `next` and every other parameter (query, filters, select, sort, size) is ignored, because
  the URL already encodes them. That round-trip (`next` out, `next` back in) is simpler and
  more reliable than reconstructing `after` from the URL by hand, and the generated tool
  cannot offer it: `next` is not a declared OpenAPI parameter on `/lines` (it only exists as
  a response field), and the vocabulary has no way to add a tool input that is not a
  parameter the document declares — `params` overrides can only rename/exclude/default an
  *existing* parameter. **Real gap**: the vocabulary has no way to say "derive this param
  from that response field" (covers both the `after` description gap and the `next`
  input-round-trip loss); fix is either an annotation `params` description override for
  `after` (cheap, would already help the description half) plus the API growing a plain
  integer `next`/cursor field so `after` and `next` speak the same value, or the vocabulary
  growing a way to declare a synthetic input param that the request-building step
  special-cases (mirroring what `agent-tools` does in code) — a bigger addition, not
  attempted here.
- `search_data missing: dateMatch` (also `aggregate_data`, `calculate_metric`) — **real
  gap**: the root API document does not declare a `date_match` parameter on `/lines`,
  `/values_agg` or `/metric_agg`, even though data-fair's runtime accepts it (confirmed
  against `agent-tools`, which sends `date_match` on the wire). This is a data-fair
  `api-contract` doc gap, not an annotation mistake — nothing in the vocabulary can add a
  parameter the document never declared. Fix: data-fair's contract generator must emit
  `date_match` on these three operations.
- `get_field_values extra: bbox, filters, geoDistance` — choice: the live API accepts
  these on `/values/{field}` (confirmed in the frozen doc); `agent-tools`' hand-written
  tool never added them. This is a capability the annotation exposes beyond the
  hand-written baseline, not a gap.
- `aggregate_data extra: metricColumn` (agent-tools nests `metric: { column, type }`,
  we flatten to `metric` + `metricColumn`) — choice: the flattened shape matches every
  other tool's `metric`/`fieldKey` convention instead of introducing the one nested object
  in the whole tool set.
- `aggregate_data extra: q` (also `calculate_metric`) — choice: the live `/values_agg` and
  `/metric_agg` endpoints accept `q` (simple query string) and the annotation does not
  exclude it, so it passes through; `agent-tools` never exposed full-text search combined
  with a metric. Kept as an additional capability, consistent with the `get_field_values`
  geo params above.
- `aggregate_data agg_size` (**not** in the final diff, but a real finding — now fixed at
  the root cause) — the API declares `agg_size` as an array (one size per nesting level,
  `explode: false`), not a scalar. An earlier draft of the annotation set
  `{ default: 20, maximum: 100 }` on it; `paramSchema()` in `src/input.ts` always applied
  `default`/`maximum` to the top-level param schema, so they landed on the array itself
  instead of its `items`. Consequence, caught only by hand-executing the tool (not by any
  schema-shape test): ajv's `useDefaults` filled in a scalar `20` for an array-typed
  property on every call, then rejected it — **`aggregate_data` failed 100% of calls**,
  including ones that never touched `agg_size`. During review a second instance of the
  identical mechanism was found live in `search_data`: the document's own `select` param
  schema is `{ type: array, items: { type: string }, default: "all" }` — a scalar default
  inherited straight from the OpenAPI document, not from any annotation — which broke
  every `search_data` call that omitted `select`. `paramSchema()` is now fixed at the
  source: whenever a parameter's schema is `type: 'array'`, any `default`/`maximum` —
  whether inherited from the raw document or added by an `agent.params` override — is
  normalized onto `items` instead of the array. `agg_size` stays excluded from
  `aggregate_data` regardless (parity with `agent-tools`, which doesn't expose it either —
  data-fair defaults it server-side to 20); the exclusion is no longer covering for a
  defect, just matching scope. Unit-tested in `test/input.test.ts` ("routes
  default/maximum onto items for an array-typed param, and keeps them top-level for a
  scalar").
- `aggregate_data sort` enum (not in the diff — schema quality finding) — the raw API
  parameter schema restricts `sort`'s array items to
  `[metric, -metric, count, -count, key, -key]`, but the same parameter's own French
  description says a trailing list of column keys is also valid
  (`"-count,key,ma_colonne,-ma_colonne2"`). The annotation does not touch `sort`'s `enum`
  (only its description), so this over-restrictive enum passes through unchanged and would
  reject a legitimate `sort: ["-count", "population"]` call. **Real gap**, but external:
  it is a pre-existing inconsistency between the OpenAPI document's schema and its own
  prose, not introduced by this annotation. It also exposes a smaller vocabulary gap: there
  is no way to *widen or clear* an inherited `enum` from `params` overrides today (`enum`
  can only be set, not unset), so even a future fix would need a new vocabulary knob.
- `search_data.sort` and `aggregate_data.sort` description/schema-type mismatch (found by
  hand-executing the tools; now fixed) — both `sort` parameters are `type: array` (inherited
  from the document, one entry per column/level, `explode: false`), but both annotation
  descriptions gave a **string** example instead: `search_data.sort` read `"Comma-separated
  column keys... e.g. \"-population\""` and `aggregate_data.sort` read `"...Example:
  \"-count\"."`. An agent following either description literally (passing a string) was
  rejected before any HTTP call: `Invalid parameters: /sort must be array`, reproduced on
  `aggregate_data` with `sort: '-count'`. "Comma-separated" describes the wire
  serialization after `explode: false` joins the array — not the shape the tool accepts.
  Same class of defect as the `search_data.fields` regression above: a description that
  promises what the schema rejects. Fixed by rewriting both descriptions to describe an
  array with an array-shaped example (`["-population"]`, `["-count"]`); verified against
  the live API with `sort: ['-p_pop0014']` and `sort: ['-count']` respectively — both
  succeed. Swept every other parameter across all six tools for the same mismatch (any
  `type: array` param described with a string example, or vice versa): `select` (already
  array-described from the earlier fix), `groupByColumns` (array, description says "1 to 3
  keys", no string-shaped example, no mismatch), `filters` (object, "key-value pairs",
  matches), `percents` (genuinely `type: string`, "comma-separated" correctly describes a
  string value) — `sort` was the only mismatch found. **Real gap**: the vocabulary lets an
  annotation rewrite a parameter's `description` freely but has no check that the rewritten
  text agrees with the (possibly inherited, possibly array-typed) schema it sits next to, so
  a description/schema contradiction ships silently. Fix: a lint pass over annotations at
  authoring time (flag a string-shaped example/wording next to a `type: array` schema and
  vice versa), or vocabulary support for describing the tool-facing shape explicitly instead
  of freehand prose.
- Every excluded/renamed OpenAPI parameter checked against the frozen document matched
  exactly (`listDatasets`, `readDescription`, `readLines`, `getValues`, `getValuesAgg`,
  `getMetricAgg` all carry precisely the parameter names the brief predicted) — no silent
  drift between the annotation authoring and the live document.
- Schema-level `title` leak (finding, not in the diff; **fixed in the final fix wave**): the
  converter copied the raw OpenAPI parameter schema (`{ ...p.schema }`) and only overrode
  `description`; the raw `title` keyword (e.g. `"Recherche textuelle"`, `"Numéro de page"`,
  French) survived untouched even where the description was rewritten to English. Any MCP
  client that surfaces `title` as a display label next to an English description would show
  mixed languages. Concretely observed, not just theorized: `sort` (both operations) carried
  `title: "Ordre des résultats"` in French right next to its rewritten English `description`,
  found while fixing the description/schema mismatch above. Fixed by dropping the inherited
  `title` in `paramSchema()` (descriptions already carry the agent-facing text, and no
  operation in the frozen doc relies on `title` being present). No `AgentParamOverride.title`
  was added — nothing in phase 1 needs to *set* a title, only to stop leaking one — but it is
  left as an obvious knob for a later phase if some client ever wants a short label distinct
  from the description.
- Binary responses (finding, not fixed — spec corrected instead): the rendering section used
  to say "binary responses are excluded at `load` with a warning." Nothing implements that;
  `load.ts`'s `execute()` branches only on `content-type.startsWith('application/json')` and
  otherwise calls `res.text()` unconditionally and returns it as the tool's text — an
  `image/png` (or any other binary) response becomes a tool that decodes bytes as text and
  hands the agent garbage, silently. The design text was corrected (see the Rendering
  section above) to describe what phase 1 actually does instead of building binary handling
  to match the old claim: no operation in the annotated frozen fixture declares a non-JSON,
  non-`text/*` 2xx response, so this was undetected until this review. **Real gap**: an
  operation whose 2xx response is declared binary (`image/*`, `application/octet-stream`,
  etc.) should either be refused at `load` (matching the original intent) or have its bytes
  handled some other way (base64, a resource link); neither is implemented. Fix is phase 2+
  work: detect a binary media type on the 2xx response during `resolveOperations` and throw
  at load, the same way `editor` now does.

None of these gaps required widening `KNOWN_GAPS` beyond what the frozen document actually
produces. Two functional bugs surfaced by hand-executing the tools were fixed rather than
documented as accepted gaps, because each made a tool non-functional (in whole or in the
common case), not merely different: `aggregate_data`'s `agg_size` (fixed at the root cause
in `paramSchema()`, kept excluded from the tool for parity with `agent-tools`) and
`search_data`'s `fields`/`selectParam` (removed; `select` exposed as free text instead, the
real per-dataset column enum being a phase-4 per-dataset-document capability, not a phase-1
one).

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
