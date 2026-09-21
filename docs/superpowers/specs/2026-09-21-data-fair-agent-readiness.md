# data-fair agent readiness — findings and recommendations

*2026-09-21. Working notes for when we add `x-agent` to data-fair's API contract.*

## Where these came from

Two exercises against `opendata.koumoul.com`:

1. **Phase 1** annotated data-fair's root OpenAPI document with `x-agent` and generated
   six `explore` tools from it, then diffed them against the hand-written
   `@data-fair/agent-tools-data-fair`. Differences that turned out to be data-fair's
   rather than the converter's are recorded here.
2. **Phase 2** ran 11 scenarios against both tool sets through a real agent and judged
   the transcripts. Its baseline lives in `evals/baselines/2026-09-21/`, and every
   anchor below was re-verified against those files before being written down.

Each item says what data-fair does today, what to change, and — where relevant — which
`x-agent` annotation becomes possible once it is changed. Several of the annotations we
want are impossible until the contract moves first.

The grouping is by **who decides**: a contract fix is a bug in the document, an API
surface addition is a missing feature, and an API behaviour change is a product call.

---

## A. Contract-only fixes

The runtime is already right; the document is wrong or silent. These are the cheapest
items here and they unblock annotations that cannot currently be written.

### A1. `date_match` is undeclared on three routes

**Today.** `GET /datasets/{id}/lines`, `/values_agg` and `/metric_agg` accept a
`date_match` query parameter at runtime — `agent-tools` sends it on the wire — but none
of the three declares it in the OpenAPI document.

**Evidence.** `test/fixtures/data-fair-root.json`: the parameter list for all three
operations contains no `date_match`. `agent-tools`' `filterProperties` includes
`dateMatch` unconditionally.

**Why it matters.** Nothing in the `x-agent` vocabulary can add a tool input the document
never declared, so the generated tools structurally cannot offer temporal filtering. This
is the clearest case in the whole exercise of a capability lost purely to a doc gap.

**Change.** Emit `date_match` on those three operations in `api/contract/dataset-api-docs.ts`,
with the format its runtime accepts (`YYYY-MM-DD`, or two comma-separated dates for a range).

**Annotation once fixed.** Rename to `dateMatch` and give it an agent-facing description,
as `agent-tools` does.

### A2. `values_agg`'s `sort` enum contradicts its own description

**Today.** The `sort` parameter on `/values_agg` restricts its array items to
`["metric","-metric","count","-count","key","-key"]`, while the same parameter's own
description states that a trailing list of column keys is also valid
(`"-count,key,ma_colonne,-ma_colonne2"`).

**Evidence.** Verified directly in the frozen document: the enum holds exactly those six
values and the description text references column keys.

**Why it matters.** The enum is the half a generated tool enforces, so a legitimate
`sort: ["-count", "population"]` is rejected before any request is sent. The `x-agent`
vocabulary can currently *set* an enum but not widen or clear an inherited one, so this
cannot be worked around on our side.

**Change.** Either drop the enum and describe the format, or extend it to admit column
keys. Dropping it is simpler and matches what the route actually accepts.

### A3. The root document's per-dataset schemas are synthetic

**Today.** `/api/v1/api-docs.json` builds its per-dataset routes from a synthetic sample
dataset (`mergedSampleDataset` in `api/contract/dataset-api-docs.ts`), so the `select`
parameter's enum and the `/lines` response schema describe seven invented columns —
`name, description, category, value, siret, image, document` — not any real dataset.

**Evidence.** Phase 1 shipped a `fields` parameter whose enum was derived from that
response schema; it rejected every real column name and had to be removed. The
per-dataset document (`/datasets/{id}/api-docs.json`) carries the real enums.

**Why it matters.** Any annotation that derives values from the root document's
per-dataset schemas produces something that looks specific and is fiction. This is not
fixable by annotation — the root document cannot know a dataset's columns.

**Change.** None required if consumers use the per-dataset document for per-dataset work,
which is the plan (it is phase 4's target). What would help is marking the synthetic parts
as such in the root document, so a generator can tell "this enum is illustrative" from
"this enum is authoritative".

### A4. The document never connects `after` to the `next` URL it returns

**Today.** `/lines` returns `next`, a fully-formed URL for the following page, and accepts
`after`, an integer cursor. The value `after` wants is sitting in `next`'s query string,
but neither parameter's description says so.

**Evidence.** `evals/baselines/2026-09-21/pagination--B.json` calls 3 and 4 — the agent
read `after=12` out of the returned `next` URL, re-supplied `datasetId` and all five
`select` columns, and got its second page. Verdict: satisfactory, no friction point.
**`after` is sufficient and it works.** This item is a documentation gap, not a missing
feature.

**Why it matters.** The agent inferred the connection here, but it had to. A caller that
does not infer it either follows `next` as a URL — which a tool caller cannot do — or
misses pagination entirely.

There is a second-order risk worth knowing about, though it did not materialise in the
run: paginating by `after` means re-supplying every other parameter, so a forgotten filter
yields page 2 of a *different* result set rather than an error. Following `next` as a URL
cannot drift that way because it carries the whole original query.

**Change.** One line in each description: say that `after` takes the value found in
`next`'s query string, and that `next` is a complete URL for the same query. No API change
needed.

**Not recommended.** `agent-tools` accepts the whole `next` URL as a tool input and
re-issues it. That is a legitimate design but a different one, and we are not copying it —
the generated tool exposing the documented `after` parameter is the simpler contract.

---

## B. API surface addition

Something genuinely missing, and useful to more than agents.

### B1. `describe_dataset` returns schemas too large to consume

**Today.** A dataset's full schema can be very large. Measured in the run:
`sirene` renders at **94,894 characters**, `contours-des-communes` at **301,312**.

**Evidence.** Eight calls in the baseline exceeded the agent SDK's per-tool-result cap and
returned an error instead of data — five on the hand-written arm
(`aggregation--A` call 6, `calculate-metric--A` call 3, `field-values--A` call 2,
`filter-search--A` call 5, `multi-step-analysis--A` call 6) and three on the annotated arm
(`aggregation--B`, `field-values--B`, `filter-search--B`, each call 2). A ninth
(`multi-step-analysis--B` call 2, `base-sirene-des-entreprises`) hit the SDK's
persisted-output path instead — 50.9 KB saved to a file with a preview returned.

Two datasets account for every hard-cap occurrence: `sirene` (seven of the eight) and
`contours-des-communes` (the eighth).

**Why it matters.** This was the single largest friction category in the run, and it hit
**both** tool sets about equally — the one problem neither hand-writing nor annotation
solved. An agent that cannot read a dataset's schema cannot query it correctly.

**Caveat, stated plainly.** Our harness inflates this. It runs with `tools: []`, which
makes the SDK's own overflow recovery unreachable: the error text tells the agent to read
the saved file with `offset`/`limit`/`jq`, and our agent has no Read, Grep or Bash. In a
normal session the agent would read the file. The problem is real — 300 KB of schema is
not something to hand any caller — but it is less severe than nine friction points suggest.

**Change.** A bounded schema representation: a summary (column key, type, title, concept,
enum presence) with the long-form descriptions and full enums available separately or
paginated. Useful to any consumer rendering a column picker, not only to agents.

**Annotation once fixed.** `response.concise` can then project the summary form by default
with `detailed` opting into the full schema — which is what the projection presets are for.

---

## C. API behaviour

Product decisions rather than bugs. Recorded because both tool sets tripped over them.

### C1. Dataset search matches tokens with no relevance ranking

**Today.** `q` on `/datasets` appears to match on any token and return results in an order
unrelated to how well they match.

**Evidence**, all from `evals/baselines/2026-09-21/search-air-quality--A.json`:

| query | count |
|---|---|
| `qualité de l'air` | 103 |
| `pollution air` | 12 |
| `air pollution AQI` | 12 |
| `pollution` | 0 |
| `polluants` | 0 |
| `indice` | 0 |
| `ATMO` | 0 |

Calls 2 and 3 returned **byte-identical** responses. Since `pollution` alone returns 0, the
12 results for `pollution air` are matched entirely by the word `air` — and
`qualité de l'air` returns 103 datasets, a 25 KB response, for a query with three content
words.

**Why it matters.** An agent reads "12 results" as "12 relevant datasets" and picks from
the top. Here the top is arbitrary. The judge failed the hand-written arm on this scenario
specifically because two different queries returned the same 12 rows, which it read as a
broken search.

**Change.** Relevance ranking, or at minimum a score in the response so a caller can tell a
strong match from an incidental one.

**Observation, unexplained.** The two arms got different counts for the same query on the
same instance: `polluants` returned 0 through the hand-written tools and 1
(`emissions-c02`) through the annotated ones. The tools send different query parameters, so
this is not necessarily an API inconsistency, but it is worth resolving before trusting
either arm's search results.

### C2. `get_field_values` returns an empty array where its siblings return a 400

**Today.** `GET /datasets/{id}/values/{field}` with a `q` that matches nothing returns
`{"values": []}` and HTTP 200, with nothing to distinguish "this field has no matching
values" from "you are querying this field the wrong way".

**Evidence.** `evals/baselines/2026-09-21/multi-step-analysis--A.json` calls 4 and 5:
`plg_code_commune` queried for `75056` and then `69123` — Paris and Lyon — both returned
`{"values":[]}` with `isError: false`. The agent had no signal, tried the second code, got
the same nothing, and moved on.

**Why it matters.** data-fair's other query routes are unusually good at this: a rejected
filter or metric returns a 400 that lists what the column *does* support, and that error is
the main way an agent self-corrects. This route breaks the pattern silently.

**Change.** Make the failure modes distinguishable — a 400 for an unknown or non-queryable
field, and ideally a hint when a `q` matches nothing on a field that does have values.

---

## What we are not asking for

- No `?format=llm`, no agent-only endpoints, no prose responses.
- Every recommendation above passes the same test: **does it help any API consumer, or
  only an agent?** A declared date filter, a real cursor, a bounded schema view, ranked
  search and a 400 instead of a silent empty array are all things a human SDK user wants.
- Nothing here asks data-fair to know about MCP or about this project.

## What is ours, not data-fair's

Recorded so this list is not mistaken for the whole picture. These are phase-3 backlog for
`openapi-mcp`, not requests to data-fair: the vocabulary cannot clear or widen an inherited
`enum`, has no `title` override, and has no check that a rewritten description agrees with
the schema it describes — the defect that produced three live bugs in phase 1, where a
description promised a scalar (`Example: "-count"`) for a parameter whose schema is an
array. Our renderer is also 10–18% bulkier than `agent-tools` on the same `sirene`
schema (94,894 chars against 104,442), which is a rendering choice of ours.
