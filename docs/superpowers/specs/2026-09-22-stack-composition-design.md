# Stack composition — design

*2026-09-22. Experimental; not aiming for production yet.*

## Why

Phase 1 turned one annotated OpenAPI document into tools; phase 2 showed they hold up
against hand-written ones; phase 3 added form editing over write operations. Every
consumer so far — the standalone binary, the evals — takes **one** document.

The data-fair stack is not one API. It is data-fair, portals, processings, catalogs,
events, notify, simple-directory: each publishes (or will publish) its own annotated
document, each is deployed behind the same reverse proxy, and an agent that is useful to
the platform needs several of them at once — publish a dataset, run a processing on it,
put it on a portal page.

This document is the step from "a document becomes tools" to "a deployment becomes a
tool set": how the stack's documents are discovered, composed into one set, served to
agents of different kinds under the right identity, and kept fresh. The end state is
one library concern (composition), one deployed server for agents outside the stack,
and a set of obligations on the other repositories.

## Consumers, and what each already has

Four kinds of agent will use the same tool set. They differ in where they run and whose
identity they carry, and that difference drives the whole design.

| Consumer | Runs | Identity | Talks to |
|---|---|---|---|
| Back-office assistant (`data-fair/agents` embedded in a page) | Browser | The user's session cookie, for free | The library, in the page, with the page's `fetch` |
| Autonomous agents (`data-fair/agents`, future) | agents service | An NHI session the service mints per run | The internal HTTP MCP server, forwarding the run's cookie on every call |
| Coding agents (Claude Code, opencode) | Developer machine | An NHI via `nhi-proxy` | The stdio MCP server, identity from the environment |
| External MCP clients (Claude Desktop, …) | Anywhere | Session or API key through the reverse proxy | The public HTTP MCP server, read profiles |

Two decisions in this table were argued and settled before writing:

- **The agents service is a generic MCP client, not a library consumer.** It could
  call `load()` in-process for less latency. It does not, because the boundary is worth
  a network hop: agents then depends on nothing but MCP, can consume a third-party MCP
  server the same way, and its browser path (`FrameClientAggregator` over WebMCP) and
  its server path become twins. Profiles do not break that genericity — a profile set is
  a parameter of the server's URL (`…/mcp?profiles=explore,edit`), which is just "an MCP
  server" to agents. Its admin UI lists servers from a registry-format listing the
  server publishes (one entry per profile), attaches the picked entries to an agent, and
  previews each over plain MCP (`server/discover`, `tools/list`, `skills/list`). An
  agent given several entries opens several connections; a tool present in two profiles
  is the same operation with the same name and collapses in the aggregator, as it
  already does across browser frames.
- **The server is `data-fair/mcp` v2, the composition is library code here.** That repo
  already carries what a stack service needs and this one should not grow: a Docker
  image, typed config, Express, rate limiting, the observer, reverse-proxy origin
  inference, and the route (`/mcp-server/datasets/mcp`) external clients already use.
  Its hand-written tools are what this project set out to replace; the repo becomes the
  deployment of what replaces them.

## Landscape (September 2026)

Two things moved under us since the phase-1 spec, and both fit.

- **MCP `2026-07-28` is GA.** Protocol sessions and `Mcp-Session-Id` are gone; every
  request is self-describing. The binary's "one server per request, no session ids" is
  now what the specification says. `tools/list` results carry a required `ttlMs` and
  `cacheScope`, so a server states its own refresh cadence to clients. Change
  notifications move to an opt-in `subscriptions/listen` stream. Cross-call state is
  "server-minted handles passed as ordinary tool arguments" — which is how editor
  sessions already address a record. The TypeScript SDK v2
  (`@modelcontextprotocol/server` and `/client` 2.0.0, published 2026-09-17) implements
  it and still serves 2025 clients unchanged; speaking the new revision is an explicit
  opt-in on both sides.
- **Skills over MCP is Final.** SEP-2640 (merged 2026-09-13) defines the official
  extension `io.modelcontextprotocol/skills`: skills are Resources under a `skill://`
  URI, discovered through `skills/list` and `skills/get`, each entry carrying the
  `SKILL.md` frontmatter verbatim and a manifest of files with SHA-256 digests. Format is
  delegated to the Agent Skills specification; content is "instructor format" —
  structured markdown, nothing executable. Hosts must namespace skills per origin,
  require per-skill approval bound to the manifest, and may decline entries whose
  manifest is `"dynamic"`. Client support is partial today (ChatGPT, fast-agent, MCP
  Inspector; Claude Code, codex, gemini-cli and goose as prototypes). The SDK has no
  first-class API for it yet: two request handlers plus resources.

Two smaller facts the design leans on. The **MCP Registry** (preview) publishes an
OpenAPI specification that private registries are expected to implement and that host
applications are meant to consume — the generic way for a host with a picker to learn
which servers exist. **GitHub's remote MCP server** selects toolsets per request
(`X-MCP-Toolsets`, `/mcp/x/<toolset>`, `X-MCP-Readonly`), the precedent for carrying a
profile set in the request rather than deploying one endpoint per profile. And Node 24's
`NODE_USE_ENV_PROXY` makes global `fetch` honour `HTTPS_PROXY`, which is the whole
integration between the stdio server and `nhi-proxy`.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Who knows the stack | data-fair serves an **index** of service-level document URLs; every consumer is configured with that one URL | data-fair and portals are the aggregators by design; the other services know only their own surroundings, and this keeps it so |
| What the index lists | Service-level documents only; no resource-level (per-dataset, per-processing) documents, no nested indexes | Resource-level documents are thousands and change with the data; they stay a consumer concern. Recursion was considered and dropped: one aggregator per deployment is enough |
| Profiles across services | A stack-wide naming convention, requested by name; a service that does not declare it contributes nothing | Remapping in the index would let two services disagree about what `edit` means; the annotation is what should change |
| Profile selection | A **set** of profiles, carried by the request (`?profiles=a,b`) on one endpoint; supersets declared with `includes` | One endpoint per profile made a client wanting several verbose and duplicated tools across connections; a tool is an operation, so a set selects each once |
| Discovery for hosts with pickers | `data-fair/mcp` v2 publishes a listing in the MCP Registry API format, one entry per profile | The registry spec is meant to be implemented by private registries and consumed by hosts; agents learns a registry URL, nothing about data-fair |
| Where composition runs | Library (`compose()`), consumed by the bin here and by `data-fair/mcp` v2 | Both stay thin; the logic is tested once |
| Failure policy | Partial sets: a failing service is excluded and reported, the rest is served; only a bad index throws | One service's outage must not take every tool away from every agent |
| Identity | Per call, through `CallContext`; the library never holds a credential | Three identity sources exist (session, NHI, API key) and a shared HTTP server serves several at once; a server holding one identity is a confused deputy |
| Session independence | Every listed document must be the same bytes for every caller on the same side of the proxy | A shared ETag cache is only correct if the document does not depend on who fetched it; permission is enforced at call time |
| Freshness | Conditional GETs in `refresh()`; the caller schedules it; `ttlMs` on `tools/list` tells clients | No timers in the library, in the same spirit as no credentials |
| Skills | `x-agent.skills` and index skills served through the skills extension; instructions unchanged | The standard exists and matches the vocabulary's text-only skills exactly; instructions remain the path every client understands today |
| MCP SDK | Migrate the adapter and bin to SDK v2 / protocol `2026-07-28`, serving 2025 clients too | The two new pieces — the server in `data-fair/mcp`, the client in agents — are greenfield; stateless HTTP, `ttlMs` and the skills extension all belong to the new revision |

## 1. Boundaries

```
L0  services        annotated api-docs, session-independent, linted + golden in CI
L1  index           data-fair  GET /api/v1/agents/index.json
L2  openapi-mcp     load() · compose() · CallContext · MCP adapter (SDK v2, skills ext.)
L3  data-fair/mcp   compose(index) → stdio | internal HTTP | public HTTP; identity forwarded
L4  consumers       browser: L2 in-page · agents: MCP client of L3 · coding agents: L3 stdio
                    behind nhi-proxy · external clients: L3 public HTTP
```

This document specifies L2 and the contract of L1. L0, L3 and L4 are obligations on other
repositories, listed in section 9 with their order.

## 2. Index contract

One JSON document served by data-fair at `/api/v1/agents/index.json`. This repository
dictates its shape and nothing else — the composer does not know it was data-fair that
served it.

```json
{
  "version": 1,
  "services": [
    { "id": "data-fair",        "openapi": "https://host/data-fair/api/v1/api-docs.json" },
    { "id": "processings",      "openapi": "https://host/processings/api/v1/admin/api-docs.json" },
    { "id": "simple-directory", "openapi": "https://host/simple-directory/api/api-docs.json" }
  ],
  "profiles": {
    "explore": { "title": "Explore", "description": "Read-only tools over every service" },
    "edit":    { "title": "Edit",    "description": "Everything explore has, plus writes" },
    "full":    { "title": "Full",    "includes": ["explore", "edit", "admin"] }
  },
  "skills": [
    { "name": "publishing-workflow", "description": "…", "profiles": ["edit"], "tools": ["datafair_create_dataset", "processings_run"] }
  ]
}
```

- **`version`** — `1`. A composer refuses a version it does not know.
- **`profiles`** — optional. Deployment-wide wording for the stack's profiles (`title`,
  `description`, localized), and deployment-wide supersets through `includes`. A profile
  absent here takes its wording from the first service declaring it. This is what a
  registry listing describes to a host with a picker.
- **`services[]`** — service-level documents only. `id` is a stable key used for
  diagnostics, skill URIs and error messages; it must match `^[a-z0-9-]+$` and be unique
  in the index. The document's own `x-agent.namePrefix` remains what makes tool names
  unique across the set. Order is priority (section 3).
- **`skills[]`** — cross-service skills, the same object as root `x-agent.skills`. Only
  the aggregator can describe a workflow that spans two services.
- **Public and private URLs.** One index, not two: its URLs are whatever the request
  resolved to. Served through the reverse proxy it lists public URLs; served on the
  private network (the stack's `PRIVATE_*_URL` convention) it lists private ones — the
  rule data-fair already applies through `reqPublicBaseUrl(req)`. A consumer configured
  with one index URL reaches everything on the same side of the proxy.
- **Caching.** The index and every document are ordinary HTTP resources with `ETag` or
  `Last-Modified`. Nothing in the contract is push-based.
- **Session independence** is a requirement on every listed document: the same bytes for
  every caller reaching it from the same side of the proxy. Annotation is curation, not
  permission; a call the caller may not make fails at call time with a tool error the
  agent can read. This is the one behavioural change data-fair owes today — its root
  document is shaped by the session (`apiDocs(reqPublicBaseUrl(req), authenticatedSession)`).

## 3. Composer

```ts
import { createComposer, compose } from '@data-fair/openapi-mcp'

const composer = await createComposer(indexUrlOrDoc, { locale, fetch, lint, structuredContent })
composer.profiles()          // [{ name, title, description, includes, services: [...] }] — union, expanded
const composition = composer.compose(['explore', 'edit'])   // memoized per distinct set
composition.toolSet          // live ToolSet { profiles, instructions, tools, skills }
composition.services         // ServiceStatus[]
await composer.refresh()     // → boolean: fetches once, rebuilds every live composition that changed
composition.onChange(cb)     // cb(toolSet) after a refresh that changed this composition

const one = await compose(indexUrlOrDoc, { profiles: ['explore'], ...opts })   // convenience over the two
```

**Profile sets.** A profile is a label on an operation; a request names a *set* of
profiles and selects every operation whose expanded labels intersect it. An operation in
both `edit` and `edit_datasets` is one operation and appears once — overlap between
profiles needs no reconciliation. `includes` (index-level and document-level, section 7)
is expanded transitively before selection. An empty set means the default profile.
Distinct sets are distinct compositions over one shared document cache: the expensive
part — fetching, `$ref` inlining, lint — happens once per document, selection is cheap.
`load()` gains the same `profiles` option and `ToolSet.profile` becomes
`ToolSet.profiles: string[]`.

```ts
interface ServiceStatus {
  id: string
  openapi: string
  status: 'ok' | 'skipped' | 'error'
  tools: number
  reason?: string          // 'declares none of [explore, edit]', 'lint: …', 'HTTP 503', 'tool name collision with data-fair: datafair_list'
}
```

**Loading.** Fetch the index; fetch every service document in parallel; run each through
`load()` unchanged. Tool generation gains nothing new here.

**Failure policy.** A service that cannot be loaded — unreachable, invalid document, lint
error, an `includes` cycle — is recorded with `status: 'error'` and excluded; the rest is
served. A service that declares none of the requested profiles is `skipped`, not an
error. `createComposer()` throws only when the index itself cannot be fetched, parsed,
or has an unknown `version`. `services[]` is what the server logs and
exposes on its status route; diagnostics never enter the agent's instructions.

**Merge.** Tools concatenated in index order. Tool names must be unique across the set;
`namePrefix` is the mechanism. On a collision the *later* service (index order) is
excluded with an error naming both services and the tool — deterministic, and one service
degrades rather than the whole set.

**Instructions.** Index skills first (filtered by the profile set), then one section per `ok`
service headed by its `info.title`, containing what `buildInstructions` produces today.
No budget mechanism yet: the readiness notes' lesson is to measure content on the real
stack before inventing structure for it.

**Skills.** `ToolSet` gains `skills: Skill[]` — `{ id, name, description, body, tools? }`
where `id` is `<service-id>/<skill-name>` (index skills: `<skill-name>` alone) and `body`
is the localized text plus a `Tools: …` line. `load()` populates it for a single document
(no service segment); `compose()` merges. The MCP adapter serves them (section 5);
instructions keep rendering them as today, so a client without the extension loses
nothing.

**Refresh, no timers.** `composer.refresh()` sends `If-None-Match` / `If-Modified-Since`
for the index and each document. A 304 costs nothing; a 200 reloads that document alone,
then re-selects every live composition that used it; a changed index adds or removes
services. Each composition's `onChange` fires once per refresh that changed *its* set. The caller owns the schedule: a `setInterval` in `data-fair/mcp`
and the bin, a manual call in tests.

**Single-document compatibility.** `load()` keeps its signature and result; a
`Composition` is what a server wants, a `ToolSet` is what a page wants.

## 4. Per-call context

```ts
interface CallContext {
  fetch?: typeof fetch                // wins over the load-time fetch for this call
  headers?: Record<string, string>    // merged into the upstream Request (Cookie, x-apiKey, …)
  signal?: AbortSignal
  identity?: string                   // opaque caller key partitioning stateful tool groups
}
Tool.execute(params, ctx?: CallContext)
```

- **Resolution.** `ctx.fetch` → `load()`'s `fetch` → global. `ctx.headers` are set on
  the `Request` before it reaches whichever `fetch` wins; a header the request already
  carries is overridden. `load({ fetch })` remains the single-identity path — the bin
  behind `nhi-proxy`, the browser with the page's `fetch` — and its behaviour does not
  change.
- **Editor sessions.** A json-layout session is state per record, and a server serving
  several callers must not let two users share one. Sessions are keyed by
  `(identity, toolName, path params)`; absent `identity` the first component is empty and
  sessions are process-global, which is correct for stdio where the process *is* one
  identity. The session's own `fetch` (schema read, document load, save) resolves through
  **the context of the call in progress**, never a context captured when the session was
  created: an NHI session cookie rotates every two minutes, so headers cached at creation
  would go stale mid-edit.
- **Adapter hook.** `toMcpServer(source, server, { context?: (req) => CallContext })`. Over
  HTTP the hook is where `data-fair/mcp` v2 copies `Cookie` and `x-apiKey` from the
  incoming request and derives `identity` (a hash of the session's user id or of the API
  key). Over stdio there is no hook, no headers, and identity is the environment.
- **Ruled out on purpose.** The library never reads a cookie, mints a session, or knows
  what an NHI is. `nhi-proxy`, the reverse proxy and later the agents service are the
  three places identity is produced; the library only carries it.

## 5. MCP adapter

Rewritten on SDK v2 (`@modelcontextprotocol/server`; the bin adds `/node` for the HTTP
handler; the evals' client moves to `@modelcontextprotocol/client`).

```ts
createMcpServer(source: ToolSet | Composition | Composer, info, { context?, refreshMs? }) → McpServer
toMcpServer(source, server, { context? })
```

- **Profile selection per request.** With a `Composer`, the request's `profiles`
  parameter (`?profiles=explore,edit` on HTTP; `PROFILES` from the environment on stdio,
  where one process is one set) picks `composer.compose(set)`; absent, the default
  profile. Under `2026-07-28` every request is self-describing and there are no sessions,
  so a URL parameter is the natural carrier — the pattern GitHub's remote MCP server uses
  for its toolsets. A set naming a profile no service declares is a request error, not an
  empty set: a typo must not silently serve nothing.
- **Live set.** With a `Composition`, `tools/list` and `tools/call` resolve against the
  current set on each request; `onChange` publishes `toolsChanged`, which the SDK routes
  to `subscriptions/listen` streams on the new revision and to `list_changed`
  notifications on the old one. With a `ToolSet` the set is fixed and no change
  notification is ever published; cache hints and skills are served either way.
- **Cache hints.** `tools/list` carries `ttlMs` = the refresh interval the caller states
  in `createMcpServer` (`refreshMs`, default 300 000) and `cacheScope: 'private'`.
  Deterministic order (index order, then document order) — the specification asks for it
  and prompt caches reward it.
- **Both protocol eras.** Modern clients are served `2026-07-28`; 2025 clients (Claude
  Desktop today) are served unchanged. The bin's HTTP mode builds a fresh server per
  request through the SDK's stateless handler, which is what it did by hand before.
- **Skills extension.** The server declares `io.modelcontextprotocol/skills` alongside
  the `resources` capability and implements `skills/list` and `skills/get`. Every
  `ToolSet.skills` entry is served as `skill://<id>/SKILL.md`:

  ```
  ---
  name: publishing-workflow
  description: …
  ---
  <body>
  ```

  The entry carries that frontmatter verbatim and a `resources` manifest of one file with
  its SHA-256 digest and size. Content is deterministic from the documents, so the
  manifest is real, never `"dynamic"`: a redeployed document changes the digest, the host
  re-asks approval, which is the intended semantics. `resources/read` serves the file as
  `text/markdown`; `directoryRead` stays `false`. Skills are not exposed as prompts.
- **Unchanged.** `_meta['anthropic/inputExamples']`, text-first results,
  `structuredContent` on request.

## 6. Binary

`INDEX_URL` or `OPENAPI_URL`, exactly one. `PROFILE` becomes `PROFILES`, a comma list
(the old name still accepted for one release). New: `REFRESH_INTERVAL` (seconds; default
`300`; `0` disables — the bin owns the timer and calls `refresh()`), `LINT`. In HTTP mode
a request's `?profiles=` overrides `PROFILES`. Everything else as today.

Identity from the environment, documented as the recipe for coding agents:

```sh
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7331 \
NODE_EXTRA_CA_CERTS=~/.config/nhi-proxy/koumoul.com/ca.crt \
INDEX_URL=https://koumoul.com/data-fair/api/v1/agents/index.json PROFILES=explore,edit openapi-mcp
```

The bin implements nothing for this. Should `NODE_USE_ENV_PROXY` fall short on the exact
Node version, an `undici` `ProxyAgent` read from the same variables is the fallback, in
the bin only. The bin's HTTP mode stays single-identity and stateless and the README
says so: it is for development; production HTTP is `data-fair/mcp` v2.

## 7. Vocabulary changes

- **Skill names follow Agent Skills.** `skills[].name` must match `^[a-z0-9]+(-[a-z0-9]+)*$`
  and be at most 64 characters, because the extension requires `name` to equal the last
  URI segment and delegates its format to that specification. Validated with the rest of
  the vocabulary; today's fixture skill `Workflow` becomes `workflow`.
- **`includes` on root profiles.** `profiles.<name>.includes: string[]` declares a
  superset: an operation labelled `edit_datasets` is selected when `edit` is requested.

  ```yaml
  x-agent:
    profiles:
      explore: { title: Explore }
      edit_datasets: { title: Edit datasets }
      edit_applications: { title: Edit applications }
      edit: { title: Edit, includes: [edit_datasets, edit_applications] }
  ```

  Expanded transitively at `load()`; a cycle or a reference to an undeclared profile
  refuses the document. Operations keep their `profiles` array, so tagging an operation
  with several remains possible — `includes` is authoring convenience for the common
  superset.
- **Recommended profile names.** `docs/x-agent.md` gains a short section naming the
  stack-wide profiles (`explore`, `edit`, `admin`), what each may contain, and the
  superset convention (`edit` includes the per-resource `edit_*` profiles), so that the
  same name means the same thing across services. Convention, not validation.
- **`toolSetSnapshot(toolSet)`** — exported helper returning a stable JSON of
  `{ name, description, inputSchema, annotations }` per tool and `{ id, name, description }`
  per skill, for the per-service golden in section 8.

## 8. Testing

**Here** — unit, mocked fetch, no network, node test runner:

- composer over an index, the data-fair fixture and a second small fixture with its own
  prefix (`petstore.json` annotated): merge order; collision → later service excluded,
  both named; `skipped` profile; `error` service excluded and reported; throw on a bad
  index and on an unknown `version`; profile sets: an operation in two requested profiles
  appears once, `includes` expands transitively (index-level and document-level), a cycle
  refuses the document, two distinct sets share one document cache (each document
  fetched once), `profiles()` is the expanded union with index wording winning;
- `refresh()`: 304 everywhere → `false`, no rebuild; 200 on one document → that service
  rebuilt, `onChange` once; index adds a service → it appears; unchanged bytes with a new
  ETag → `false`;
- `CallContext`: `ctx.fetch` beats load-time fetch; `headers` reach the `Request`;
  `identity` partitions editor sessions and its absence shares them; a session's fetch
  uses the current call's headers, not the creating call's;
- adapter over an in-memory transport, both protocol eras: `?profiles=` selects the
  composition and an undeclared profile is a request error; live `tools/list` after a
  change; change notification delivered; `ttlMs`/`cacheScope` present; `skills/list`,
  `skills/get`, `resources/read` of a skill, digest matches the bytes; unknown skill URI
  → `-32602`;
- vocabulary: skill name rule; snapshot helper stable across runs;
- bin smoke: `INDEX_URL` against `evals/fixture-server.ts`, stdio and HTTP.

**Per service** — the pattern each stack repository adopts, documented in the
`skills/openapi-mcp` skill: `load(ownDocument, { lint: 'error' })` for every declared
profile, then `toolSetSnapshot` diffed against a committed golden. An agent-facing change
becomes a reviewable diff in the pull request that causes it — the class of defect the
readiness notes' A1, A2 and A7 were.

**Evals** — arm C: the composed set over an index served by the fixture server, same
scenarios as A and B. Expectation: parity with B on verdicts; the number to watch as
services are added is tool-definition tokens. Multi-service scenarios (publish, process,
put on a portal) belong to data-fair's simulations on the dev environment with NHI
identities; they are named in section 9, not built here.

## 9. Roadmap across repositories

Ordered by dependency. Only step 1 is planned in detail from this document.

1. **This repository (0.2.0).** `CallContext` and the adapter hook → SDK v2 adapter with
   the skills extension → `compose()` with the live adapter → bin, vocabulary changes,
   `toolSetSnapshot` → eval arm C.
2. **data-fair.** The index endpoint; a session-independent root document; emit `x-agent`
   (phase 4 of the phase-1 spec, still not done — until it lands the composed set over
   the real stack is empty); lint and golden in CI.
3. **`data-fair/mcp` v2.** `createComposer()` over the index; stdio and one HTTP endpoint
   with `?profiles=`; the context hook forwarding `Cookie` / `x-apiKey` and deriving
   `identity`; the refresh timer; rate limiting; the existing route kept; a listing in
   the MCP Registry API format (`GET …/v0/servers`), one entry per profile from
   `composer.profiles()` with its `remotes[].url` carrying `?profiles=<name>`; the
   hand-written tools and the `agent-tools` dependency retired once arm C passes against
   it.
4. **Other services.** processings and simple-directory annotate the documents they have;
   catalogs, portals and events publish documents first.
5. **agents.** A generic MCP client: operator-level registry URLs, per-agent server
   entries picked from them, preview over MCP under the admin's session, one connection
   per entry at run time with tools merged by name, per-run cookie forwarding; NHI
   minting; autonomous runs — its own specification. Nothing in it names data-fair.
6. **Simulations.** Multi-service cases on the dev environment.

## Non-goals

- Resource-level documents in the composed set, and nested indexes.
- Executable skills, or skills as prompts.
- The browser assistant over HTTP MCP: the library in the page is the path; the door
  stays open.
- Any credential handling in the library.
- Instruction budgets: measured first.
- `export-skills` to `SKILL.md` directories on disk: the bytes now exist, the command is a
  follow-up once the stack carries skills worth installing.

## Layout

```
src/
  compose.ts          index fetch, document cache, profile-set selection, merge, refresh
  index-contract.ts   index JSON schema and validation
  context.ts          CallContext resolution (fetch, headers, signal)
  snapshot.ts         toolSetSnapshot
  adapters/mcp.ts     SDK v2: live set, cache hints, both eras, skills extension
  bin/server.ts       INDEX_URL | OPENAPI_URL, REFRESH_INTERVAL, stateless HTTP handler
  editor/             sessions keyed by identity; fetch resolved per call
  vocabulary/         skill name rule, profile includes expansion
test/fixtures/        index.json, annotated petstore as a second service
evals/                arm C
docs/x-agent.md       skills format, recommended profiles, per-service golden pattern
```
