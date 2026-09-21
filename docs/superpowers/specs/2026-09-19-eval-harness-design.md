# openapi-mcp eval harness (phase 2) — design

*2026-09-19. Experimental; not aiming for production yet.*

## Question

Phase 1 produced six `explore` tools for data-fair from `x-agent` annotations alone, and
a written list of how they differ from the hand-written tools in
`@data-fair/agent-tools-data-fair`. That list compares *parameter shapes*. It cannot say
whether an agent actually gets as far with one set as with the other.

This harness answers that: the same questions, put to the same model, against two MCP
servers that differ only in where their tools came from.

- **Arm A** — `data-fair/mcp`, the hand-written server (7 tools).
- **Arm B** — this project's standalone binary on the frozen annotated root document,
  `explore` profile (6 tools).

Success criterion, from the phase-1 design: **B passes the same scenarios at ≤ 1.2× the
tokens.** Everything else the run produces is qualitative and is phase 3's input.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Runner | `@anthropic-ai/claude-agent-sdk`, in-process, one `query()` per run | Authenticates off Claude Code's own credentials (no API key), takes `mcpServers` directly, reports usage. Both arms stay genuine MCP servers behind a genuine MCP client — which is the claim under test. |
| Isolation | `lib-sim`'s `isolationOptions()` shape, reproduced here | Measured, not assumed, in a sibling project: a neutral cwd is what removes auto-memory (it is keyed to the project directory), and `tools: []` is what stops the SDK offering its own built-ins instead of the tools under test. |
| Scenarios | The 11 from `data-fair/mcp/evals`, `geocode-address` dropped | Geocoding wraps a third-party API with no annotations — a stated non-goal of the converter, already documented. Spending a run to re-discover it adds nothing. |
| Judging | Independent per-arm verdict, arm not disclosed, plus anchored friction points | The token criterion is arithmetic. The judge's job is the qualitative half: where the annotated tools made the agent work harder. |
| Arm A source | Local sibling checkout, provenance recorded per run | The question is parity with the hand-written tools *as they stand*; a pinned release would answer a different one. Each transcript records what it actually measured. |
| Arm B spec source | The frozen annotated fixture, served over a local HTTP server | Measures the annotations under test, not whatever the live document says that day. |
| Model | Pinned by env, default `haiku` | A tool set that carries a small model carries a large one; the reverse is not true. Also what makes the suite cheap enough to re-run after every annotation change. |
| Concurrency | Sequential by default | 22 runs against one rate-limited public instance; a 429 lands as a tool error and corrupts exactly the comparison being made. |
| Live data | Accepted, timestamped | Both arms hit the same instance in the same run, so drift affects them equally; the transcript carries its timestamp. |

## Layout

```
evals/
  scenarios.json      11 scenarios (copied from data-fair/mcp, geocode-address dropped)
  arms.ts             the two mcpServers configs + provenance capture
  isolation.ts        neutral cwd, settingSources:[], tools:[], scrubbed env, strictMcpConfig
  run.ts              runs (scenario x arm), writes one transcript JSON per run
  judge.ts            prompts the judge per transcript, parses + validates the verdict
  verdict.ts          the verdict schema and its parser
  report.ts           summarises runs into a table
  runs/               working output (gitignored)
  baselines/<date>/   committed snapshots of a full run
```

Scripts: `eval:run`, `eval:judge`, `eval:report`, and `eval` to chain them.
`@anthropic-ai/claude-agent-sdk` is a devDependency; the library gains no runtime
dependency.

## Arms

The only difference between the two runs of a scenario is one `mcpServers` entry.

- **A**: `command: node`, `args: [<DATA_FAIR_MCP>/index.ts]`,
  `env: { PORTAL_URL: 'https://opendata.koumoul.com', TRANSPORT: 'stdio' }`.
  `DATA_FAIR_MCP` defaults to `~/data-fair/mcp`. A missing checkout fails loudly naming
  the path it looked for — never a silently skipped arm.
- **B**: `command: node`, `args: [src/bin/server.ts]`,
  `env: { OPENAPI_URL: <local fixture URL>, PROFILE: 'explore' }`. `run.ts` starts an
  ephemeral HTTP server on port 0 for the duration of the run, serving
  `test/fixtures/data-fair-root.json` with the `x-agent` annotations merged in (the same
  `annotateDataFair()` the parity test uses) and `servers[0].url` left pointing at
  `https://opendata.koumoul.com/data-fair/api/v1`, so the spec is the frozen annotated one
  while the data is live.

Provenance recorded per run: for A, its `package.json` version and git SHA; for B, the
fixture's hash and the profile.

The runner prompt is **the scenario question and nothing else**. Each server supplies its
own `instructions` through the protocol, and that guidance is part of what is being
compared; harness-side hints would measure the harness.

## Running

One run = one `query()` with the isolation options above and exactly one `mcpServers`
entry. Model from `OPENAPI_MCP_EVAL_MODEL` (default `haiku`), recorded per run. Sequential
by default; `--concurrency N` for when the rate-limit risk is accepted.

Each run writes one JSON: scenario id, arm, model, ISO timestamp, arm provenance, every
tool call in order with its arguments and the verbatim text it returned, the final answer,
and metrics — tool calls, tool errors, input/output/cache tokens, cost.

A run that errors is recorded, not retried: the failure is a datum.

**Tool-definition tokens are measured separately and statically** — list each arm's tools
once, serialize, count. No model run needed, and it is the number that says whether a tool
set is affordable before a single scenario runs. (B is currently 15.1 KB across 6 tools.)

## Judging

The judge runs through the same SDK and the same isolation options as the runner, with its
own pinned model: `OPENAPI_MCP_EVAL_JUDGE_MODEL`, default `sonnet`. The runner is
deliberately the smallest tier, to stress the tools; the judge is not, because reading a
transcript carefully is the harder task and a weak judge yields weak findings. The judge's
model is recorded alongside the runner's in every verdict.

The judge sees one transcript at a time and is **not told which arm produced it**. It gets
the scenario's question, its `expected` description, and the ordered calls with their
verbatim returns. It returns:

```json
{ "scenario": "...", "verdict": "satisfactory|unsatisfactory", "reasoning": "<one paragraph>",
  "friction": [ { "call": 1, "tool": "...", "observed": "...", "inferred": "...",
                  "severity": "high|medium|low" } ] }
```

`verdict.ts` validates every field and throws on anything malformed: a verdict that cannot
be parsed must fail at parse time rather than read as "no problems found", and a friction
point without a 1-based call number anchors nothing. An unjudged run counts as a failure —
a transcript nobody read is not evidence.

**Friction is the deliverable.** With 11 scenarios both arms will likely pass most, so the
pass column is coarse; the anchored friction points are what say where the annotated tools
made the agent work harder, and they are phase 3's input the way the gap list was phase
2's.

## Reporting

One row per scenario x arm — verdict, tool calls, tool errors, tokens, cost — then the
three totals that answer the question:

1. pass rate per arm,
2. B/A total-token ratio against the ≤ 1.2 criterion,
3. the static tool-definition sizes.

No other thresholds: the numbers are context, the verdict is the judge's. A scenario with
no transcript fails the report loudly rather than disappearing from it.

A run becomes a baseline when you say so: `evals/baselines/<date>/` holds a committed copy
of its transcripts, verdicts and report, so a later run stays comparable even though the
live data underneath has drifted.

## Testing the harness

Unit tests cover the pure parts: verdict parsing including malformed cases, report
summarising including a missing transcript, arm-config construction including the
missing-checkout failure, and the scenario file's shape. The model-driven parts are not
unit-tested — they are the thing being measured.

## Non-goals

- Not a CI gate. It costs money and hits a live public instance; it runs when an
  annotation or a tool changes.
- No pass/fail thresholds beyond the stated token ratio.
- No third-party-API scenarios (`geocode-address`), which the converter cannot serve by
  design.
- No comparison of output *formatting* beyond what the judge notices as friction.

## First run

Run on 2026-09-21. Runner model `haiku` (`OPENAPI_MCP_EVAL_MODEL`, default), judge model
`sonnet` (`OPENAPI_MCP_EVAL_JUDGE_MODEL`, default). Portal: `https://opendata.koumoul.com`
(live, timestamped per run).

- **Arm A provenance** — `/home/alban/data-fair/mcp`, version `0.7.5`, commit `9a92dc9`.
- **Arm B provenance** — the frozen annotated fixture, `fixtureHash 75d4825320c6`,
  `explore` profile, served locally.

All 22 runs completed with no thrown runs, no harness errors, and no repeated-error
console flag. All 22 transcripts judged on the first pass — `parseVerdict` never threw,
so there is no judging-failure to report. Baseline saved at `evals/baselines/2026-09-21/`
(46 files: 22 transcripts, 22 verdicts, `tool-definitions.json`, `report.md`).

### The table

| scenario | arm | verdict | calls | errors | friction | tokens | cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| aggregation | A | pass | 8 | 2 | 4 | 100111 | $0.0579 |
| aggregation | B | pass | 4 | 0 | 1 | 54477 | $0.0265 |
| calculate-metric | A | pass | 6 | 0 | 1 | 75670 | $0.0473 |
| calculate-metric | B | pass | 3 | 0 | 0 | 42457 | $0.0224 |
| describe-dataset | A | pass | 2 | 0 | 0 | 23388 | $0.0266 |
| describe-dataset | B | pass | 2 | 0 | 2 | 31596 | $0.0252 |
| empty-results | A | pass | 2 | 0 | 0 | 18016 | $0.0176 |
| empty-results | B | pass | 1 | 0 | 0 | 17238 | $0.0109 |
| explore-unknown | A | pass | 11 | 0 | 0 | 96398 | $0.1137 |
| explore-unknown | B | pass | 6 | 0 | 0 | 52120 | $0.0696 |
| field-values | A | pass | 5 | 1 | 2 | 61600 | $0.0515 |
| field-values | B | pass | 5 | 0 | 2 | 76211 | $0.0402 |
| filter-search | A | pass | 6 | 0 | 2 | 76335 | $0.0569 |
| filter-search | B | pass | 4 | 1 | 2 | 52152 | $0.0275 |
| multi-step-analysis | A | pass | 10 | 1 | 5 | 112370 | $0.0562 |
| multi-step-analysis | B | pass | 6 | 2 | 3 | 74035 | $0.0326 |
| pagination | A | **fail** | 5 | 1 | 1 | 55475 | $0.0394 |
| pagination | B | pass | 4 | 0 | 0 | 59555 | $0.0325 |
| search-air-quality | A | **fail** | 9 | 0 | 5 | 61791 | $0.0503 |
| search-air-quality | B | pass | 8 | 0 | 4 | 57370 | $0.0305 |
| stats-metric | A | pass | 3 | 0 | 0 | 56490 | $0.0517 |
| stats-metric | B | pass | 8 | 1 | 1 | 123389 | $0.0477 |

never ran: 0, not judged: 0, harness errors: 0

**Totals** (real numbers, not rounded in B's favour):

- Arm A: 9/11 satisfactory (82%), 737,644 total tokens.
- Arm B: 11/11 satisfactory (100%), 640,600 total tokens.
- **B/A total-token ratio: 0.87** (criterion: ≤ 1.2 — comfortably met).
- **B/A input+output ratio (excludes cache): 0.88** — input+output tokens: A 31,930,
  B 28,104. This ratio is closer to the real interaction cost than the cache-inclusive
  headline (the warning that these two might diverge is a controller ruling recorded in
  the SDD progress ledger and as a comment in `evals/report.ts`, not something stated in
  this design doc's earlier sections — corrected here after review). In this run the two
  ratios do **not** diverge: both say B used fewer tokens. See below for *why* they agree.
- Tool definitions: **A 7 tools, 10,899 bytes**; **B 6 tools, 15,136 bytes** — B's tool
  definitions alone are ~39% larger on disk. But the tool definitions are not the whole
  static preamble: both servers also send an `instructions` block through the protocol on
  every turn, which the "Arms" section above already says is part of what's being compared
  and which `definitionBytes` never counted. Measured after this run (`instructionsBytes`
  was added to `discoverTools` in the post-run fix pass, so it is not in the committed
  baseline's `tool-definitions.json`): arm A's instructions are 3,033 bytes, arm B's 1,156.
  Including them, the real static preamble is **A 13,932 bytes vs B 16,292 bytes — B is
  ~17% larger**, not ~39%. This *did* cost more per turn (see below); B won on aggregate
  only because it needed fewer turns.
- **Per-scenario spread**: B/A total-token ratio ranges from **0.54 to 2.18** across the
  11 scenarios. B is *more* expensive in 4 of 11: `stats-metric` 2.18, `describe-dataset`
  1.35, `field-values` 1.24, `pagination` 1.07. The aggregate 0.87 is not representative of
  every scenario — `stats-metric` in particular is the run's largest single outlier in
  either direction (123,389 vs 56,490 tokens) and is discussed below.
- Friction points: A 20, B 15.

**Where the two ratios' agreement actually comes from.** The controlled comparison is the
two scenarios where both arms made the *same number of tool calls* — `describe-dataset`
(2 calls each) and `field-values` (5 calls each) — because call count is held constant
there, so any token difference is attributable to the tool definitions and response
rendering, not to one arm doing less work. On those two: `describe-dataset` B/A = **1.35**,
`field-values` B/A = **1.24**. Aggregated across all 22 runs: arm A made 67 tool calls
across 78 SDK turns (9,457 tokens/turn, 6,473 cache-read tokens/turn); arm B made 51 calls
across 62 turns (10,332 tokens/turn — **+9%** over A — and 8,127 cache-read tokens/turn —
**+26%** over A). So B's larger static preamble (tool definitions **and** instructions —
~17% larger combined, see the tool-definitions bullet above) did carry a real per-turn
premium, exactly as the design anticipated. B won in aggregate because it needed **~21%
fewer turns**
(62 vs 78) to reach an answer, which outweighed that premium. And because both the
cache-read total and the input+output total scale with turn count, a 21% turn gap pulls
both ratios in the same direction together — that is the actual mechanism behind the two
ratios agreeing here, not evidence that the definition-size risk doesn't apply. The risk
bites exactly when call counts are close, which `describe-dataset` and `field-values`
both are (B/A > 1 in both): a future annotation change that costs B one extra call in a
scenario where turn counts are otherwise similar will show up as a real cost, not be
absorbed by fewer turns elsewhere.

### Friction findings, grouped

Every friction point below is anchored to `<scenario>--<arm>`, the call number, and its
judge-assigned severity.

**1. Oversized `describe_dataset` responses that exceed the SDK's own output-size cap
(the single largest real-defect category, and roughly symmetric across arms)** — a
wide-schema dataset's `describe_dataset` call throws `Error: result (N characters)
exceeds maximum allowed tokens`, forcing the agent to abandon direct schema inspection
and guess field names instead:
- `aggregation--A` call 6, `aggregation--B` call 2 (94,894 / 104,442 chars) — dataset
  `sirene`
- `calculate-metric--A` call 3 (301,312 chars) — dataset `contours-des-communes`, **not**
  `sirene`
- `field-values--A` call 2 (94,894 chars) — dataset `sirene`; `field-values--B` call 2
  (111,510 chars) — dataset `sirene` with `response_format: "detailed"` requested
  explicitly
- `filter-search--A` call 5, `filter-search--B` call 2 (94,894 / 104,442 chars) — dataset
  `sirene`
- `multi-step-analysis--A` call 6 (94,894 chars) — dataset `sirene`

(`multi-step-analysis--B` call 2 was previously listed here too, filed as a sixth hard-cap
hit on `base-sirene-des-entreprises`. It is not one — see the callout below.)

This category generalises beyond the `sirene` dataset — `contours-des-communes` hits the
same cap independently — so it is a property of wide-schema datasets against the SDK's
output-size limit in general, not specific to one dataset, though the direct evidence for
that generalisation rests on two datasets (`sirene` and `contours-des-communes`), not
three. It hits both arms at close to the same rate on this mechanism (**5 A points, 3 B
points** — verified by scanning every baseline transcript for the literal `exceeds
maximum` error text), and is not really a parity finding: both tool sets fail the same way
when a schema is wide enough.

A real parity signal *is* hiding inside this group, though: for the identical `sirene`
dataset called with identical arguments (`{"datasetId":"sirene"}`, no `response_format`),
arm A's error is **always exactly 94,894 characters**, while arm B's is **always exactly
104,442 characters** — about **10% bulkier for byte-identical underlying content**. When
B's `response_format: "detailed"` is requested explicitly it grows further, to 111,510
(**~17.5%** bulkier than A's baseline). Both arms are equally capped by the SDK, but B's
`describe_dataset` rendering is consistently heavier for the same information, which
matters for how close a future schema is to tripping the cap on one arm and not the other.

**Not in this group: `describe-dataset--B` call 2.** Its friction was originally filed
here as a tool defect ("the response was cut before the real data"); it is not one. That
call's `describe_dataset` response is 16,146 bytes and **complete** — dataset
`communes-de-france`, no SDK size-cap error at all, 21 schema keys present. What actually
happened is that the *judge's own prompt* truncates any call response over 4,000
characters before showing it to the judge (`evals/judge.ts` line 49); the judge saw a cut
view of a response the tool delivered in full. The judge's own friction text says exactly
this — "not visible in the *truncated schema output shown here*" — and rated the run
**satisfactory**, low severity. No wrong column count was ever established; there is no
evidence the agent's ~17-column answer was actually incorrect, only that the judge
couldn't verify it from its own truncated view. This is a judge-harness limitation, not a
finding about either tool.

**Also not in this group (corrected): `multi-step-analysis--B` call 2.** It was previously
filed as a sixth hard-cap hit, alongside the five above. It is not: that call has
`isError: false`, and its response is not the `exceeds maximum` error text at all — it is
the SDK's own **persisted-output preview**, `Output too large (50.9KB). Full output saved
to: <path>` followed by a ~2,246-character preview of the actual JSON. This is a different
mechanism from the hard cap: the tool call succeeded, the SDK simply declined to inline all
50.9KB of it and offered the agent a file path instead (which the agent could not act on —
see "What surprised" below), and the agent carried on rather than erroring out. Filing it
under the hard-cap group double-counted a defect that doesn't belong there and inflated B's
count in that group from 3 to 4, and the run's total wide-schema-datasets-hit-a-limit count
from two mechanisms to what read as one. Verified by scanning every baseline transcript for
both `exceeds maximum` (present in `aggregation--A`, `aggregation--B`,
`calculate-metric--A`, `filter-search--A`, `filter-search--B`, `field-values--A`,
`field-values--B`, `multi-step-analysis--A` — never in `multi-step-analysis--B`) and
`Output too large` (present only in `multi-step-analysis--B`).

That limitation is bigger than this one call. **9 of the run's 35 friction points sit on
a call whose response the judge saw truncated at 4,000 characters**: `describe-dataset--B`
call 2 (×2, both friction items on that one call), `field-values--B` call 4,
`search-air-quality--A` calls 1–3, and `search-air-quality--B` calls 1, 2, 7. Most of
these are still substantively real — the tool *did* return partial or lower-relevance
data, and the judge's read of that is reasonable — but a phase-3 reader currently cannot
tell, from the friction list alone, which "truncated" means "the SDK capped the tool's own
output" (a real limit both tools hit) versus "the judge's prompt-construction cut a
complete, correct response before reading it" (an artifact of the judge, not the tool).
Phase 3 should either raise the judge's truncation threshold or have it note when a
response was cut, so this distinction doesn't have to be reconstructed by hand again.

**2. Tool/schema rejected a guessed parameter value (agent had no way to know the valid
field name or sort key in advance, in either arm)**:
- `aggregation--A` calls 3–4 (sort keys `-count`, `-metric` both rejected)
- `field-values--A` call 3 (`forme_juridique` unknown field)
- `filter-search--B` call 3 (`ville` unknown field — direct consequence of the
  `describe_dataset` truncation in call 2 of the same run)
- `multi-step-analysis--A` calls 3, 7 (commune-code filter value and `nom_rais_sociale`
  field both rejected)
- `multi-step-analysis--B` calls 3–4 (`commune_siege` guessed, rejected, then **guessed
  again identically** for a second city — a "fetched/tried twice with no new information"
  case)
- `stats-metric--B` call 5 (`Montant` field is typed `string` in the schema despite
  holding numeric values, so `calculate_metric`'s "stats" mode rejected it — neither tool
  description warns that the stats metric requires a genuinely numeric field type before
  the call)

This category is also roughly symmetric across arms. Neither tool set exposes a
discoverable enum of valid field/sort-key names up front; both make the agent learn valid
names by trial and error against the live API's 400 responses.

**3. Response that misled the agent into a wrong intermediate or final conclusion**:
- `aggregation--A` call 5 — proceeded with commune-granularity data that could not answer
  the higher-granularity question asked.
- `filter-search--A` call 4 — assumed an INSEE commune code returned by `geocode_address`
  would match `plg_code_commune` values in a different dataset; got zero results without
  verifying the assumption first.
- `multi-step-analysis--A` call 3 — same assumption, same zero-result outcome, in a
  different scenario.
- `field-values--B` call 4 — `get_field_values` returned a truncated, alphabetical list
  with no total count; the agent's final answer stated a specific approximate count
  ("plus de 330 catégories") that the response never actually supported. (Also one of the
  9 judge-truncated calls noted in Group 1.)
- `describe-dataset--B` call 2 (the date-inconsistency friction item, distinct from the
  judge-truncation item discussed in Group 1) — call 1 (`list_datasets`) returned
  `updatedAt: 2026-09-10T08:45:06.175Z`, but the agent's final answer stated the dataset
  was last updated "2 septembre 2026" — a real, minor factual slip by the agent, unrelated
  to any truncation.
- `search-air-quality--A` (calls 1, 2, 4, 8) and `search-air-quality--B` (calls 1, 2, 5, 7)
  — **both arms'** `list_datasets`/search does apparent keyword-OR matching with no
  relevance ranking, so a multi-word query collapses to whichever single word has any
  matches at all, returning mostly-irrelevant hits ("Schéma Aires de livraison" for
  "qualité de l'air", etc.). The clearest evidence is within arm A's own transcript: call 2
  (`q: "pollution air"`) and call 3 (`q: "air pollution AQI"`) return the identical 12
  results in the identical order, while call 8 (`q: "pollution"` alone) returns 0 — i.e.
  the word "air" alone is what produces those 12 hits, regardless of what else is in the
  query, and "pollution" contributes nothing. This is the benign, better-supported
  explanation for the identical-results observation (previously filed as a standalone
  high-severity tool bug — see the correction in Group 4). **Both arms' final answers
  reached the same conclusion** — "no air-quality dataset exists on this platform" — and
  **neither actually satisfied the scenario's `expected`** ("list air-quality datasets
  with titles and descriptions"); B passed only because its answer hedged
  ("*ne semble pas proposer actuellement*") while A's read as more definitive, which the
  judge weighted heavily. B still took 4 friction points on this same shared search
  defect — it did not avoid the underlying problem, it was judged more charitably for how
  it phrased the same underlying negative finding.

  There is a narrower, real, arm-A-only signal in the same transcripts, distinct from the
  shared keyword-OR problem above: for `q: "polluants"`, arm A's `list_datasets` returned
  `count: 0`, while arm B's equivalent query returned `count: 1` (the `emissions-c02`
  dataset). The two arms' search genuinely diverges on this one query, and B's result was
  the more useful one (it is what let B's final answer at least mention emissions data,
  even though it still concluded "no air-quality dataset").

**4. Genuine tool bug (high severity — confirmed, the direct cause of one of the two
FAILs)**:
- `pagination--A` call 4 (severity **high**) — the hand-written tool's own `next` cursor
  URL, fed back into `search_data`, throws `MCP error -32602: Output validation error:
  Invalid structured content for tool search_data: [{"code":"invalid_type",
  "expected":"number","received":"undefined","path":["total"],"message":"Required"}]`. The
  agent could not recover a working pagination path from the tool's own advertised
  mechanism, abandoned cursor-based pagination, and re-issued a single `size=20` query
  instead — which produced a correct *list* of communes but never demonstrated the
  two-page retrieval the scenario asked for. This is what the judge failed the run on, and
  it is a genuine defect in arm A's own tool, not a symmetric or shared problem.

**Correction: `search-air-quality--A`'s FAIL is not a second arm-A-only tool bug.** It was
previously filed here as a second high-severity defect unique to arm A ("byte-identical
results for two different queries" read as broken search). That framing over-attributes
the FAIL: as Group 3 above shows, both arms exhibit the same keyword-OR/no-ranking search
behaviour, both arms reached the identical "no data" conclusion, and B took 4 friction
points on the same issue. The one FAIL/pass split between the two arms on this scenario
came down to phrasing and how the judge read it — see finding 5 below on why that split is
not strong evidence of a real capability gap.

Arm A's two FAILs are therefore not symmetric findings: `pagination--A` is a confirmed,
arm-A-only tool defect with clear mechanical evidence (a schema-validation error on the
tool's own emitted cursor). `search-air-quality--A` is a shared search-quality problem
that both arms hit, where the FAIL/pass split reflects the judge's read of two similar
answers more than a real difference in what either tool set could do.

**5. Information the agent had to fetch twice, for no new information** — the brief's
third friction axis, previously ungrouped:
- `multi-step-analysis--A` calls 4 and 5 — `get_field_values` on
  `plg_code_commune` returns `{"values":[]}` for *two different* commune codes in a row.
  The tool returns a silent empty array rather than an error for a field/value combination
  that cannot be resolved, so the agent has no signal after the first empty result that
  repeating the same kind of lookup with a different value is equally futile; it pays for
  a second round trip to learn nothing new. This is a distinct, actionable phase-3 item:
  `get_field_values` (or the underlying API) could distinguish "field exists but this
  value has zero matches" from something the agent could act on differently, or the tool
  description could warn that an empty result doesn't validate the *field name*, only the
  *value*.
- Related, though already anchored in Group 2: `multi-step-analysis--B` calls 3–4 guess
  the same wrong field name (`commune_siege`) twice in a row for two different cities —
  the same "tried twice, no new information" shape, just with a rejected guess instead of
  a silent empty result.

These two calls (`multi-step-analysis--A` calls 4–5) were missing from the friction
groups in the original write-up, which also incorrectly claimed the group counts
reconciled exactly for both arms. They reconcile exactly for **arm B** (15 of 15). For
**arm A**, the original groups covered 18 of the 20 friction points; adding this group
accounts for the remaining 2 and brings arm A's total to 20 of 20 as well.

### Answer to the phase-1 question

**Can annotations alone match the hand-written tools?** On this run's evidence: **broadly
yes on pass rate and aggregate tokens, but the margin is thinner and less one-sided than
either number suggests on its own.** Only one of A's two failures is a confirmed,
arm-A-only tool bug; the other is a shared search-quality weakness both arms exhibit,
scored asymmetrically by the judge. B is cheaper in aggregate but *more* expensive than A
in 4 of 11 scenarios, including one large outlier (`stats-metric`, 2.18×). Both tool sets
share the same dominant friction (oversized schema responses, unguessable valid field/sort
names) — annotations did not solve that; they mainly avoided introducing arm A's specific
bugs.

Specifically:
- B passed every scenario (11/11) against A's 9/11, but the two FAILs are not equally
  strong evidence. `pagination--A` is a confirmed, mechanically-evidenced defect in arm
  A's own tool (its `next` cursor fails the tool's own output validation when fed back in)
  — genuine evidence that *this specific hand-written server* has a bug the annotated one
  avoids, not proof that annotation-derived tools are inherently more reliable.
  `search-air-quality--A`, on inspection, is **not** a second arm-A-only defect: both arms
  hit the same keyword-OR/no-ranking search behaviour, both reached the identical "no
  air-quality data" conclusion, and B took 4 friction points on the same problem — B
  passed mainly because its answer hedged more explicitly, which the judge weighted
  heavily. So the honest pass-rate story is "B avoided one confirmed A-only bug and won a
  close, arguably judge-dependent call on the other," not "B is cleanly ahead 11 to 9 on
  substance."
- B used fewer tokens on both the headline ratio (0.87) and the cache-excluded ratio
  (0.88), comfortably under the ≤ 1.2 criterion either way — but not uniformly: B/A ranges
  from 0.54 to 2.18 across the 11 scenarios, and B is the *more expensive* arm in 4 of
  them (`stats-metric` 2.18×, `describe-dataset` 1.35×, `field-values` 1.24×, `pagination`
  1.07×). B's larger static preamble (tool definitions 15,136 vs 10,899 bytes, **and**
  instructions 1,156 vs 3,033 bytes — combined, 16,292 vs 13,932 bytes, B ~17% larger; the
  instructions figures were measured after the run) did carry a real per-turn cost — B used
  +9% more tokens and +26% more cache-read tokens per SDK turn than A. B won
  in aggregate purely because it needed ~21% fewer turns overall (62 vs 78), and because
  turns is what both the cache-read total and the input+output total scale with, that
  turn-count gap is what carries both ratios in the same direction — not some property
  that makes B's larger definitions free. In any scenario where call counts land close
  together (as in `describe-dataset` and `field-values`), the definition-size premium
  shows through directly, and B loses on tokens.
- The friction analysis is the qualifying half, and needs its own qualification too. The
  single largest friction category (oversized `describe_dataset` responses hitting the
  SDK's own output-size cap) generalises across several wide-schema datasets and hits both
  arms at close to the same rate — genuinely symmetric, not a parity finding. The
  second-largest category (guessed field/sort-key names rejected by the live API) is also
  symmetric. But one of the run's five friction categories — a genuine, arm-A-only search
  divergence (`polluants`: A found 0 datasets, B found 1) — plus the confirmed pagination
  bug, are real asymmetries in A's favour of *not existing*, i.e. real problems specific to
  arm A that arm B did not have. Annotations alone did not solve the two symmetric
  problems (discoverability of valid field/sort-key names, safe handling of wide schemas);
  they simply didn't introduce arm A's specific bugs either.

Put plainly: on this run, the annotated `explore` tools got the agent at least as far, at
a token cost that was lower in aggregate but *higher* in exactly the scenarios where both
arms did comparable work, than the hand-written tools. B's aggregate win owes more to
needing fewer turns than to its tools being qualitatively better per turn, and one of its
two "wins" over arm A (the search scenario) is a shared weakness that the judge scored
asymmetrically rather than a case where B's tools actually did more for the agent. Both
tool sets leave the same structural gaps — oversized schema responses, no discoverable
valid-value list for filters/sorts, and (newly surfaced) silent-empty-array responses that
cost a second round trip — for phase 3 to address; annotations changed which specific bugs
showed up, not whether these structural gaps exist.

### What surprised

- Neither the plan nor phase 1's gap list anticipated that the hand-written arm A tools
  themselves would have functional bugs. The design doc worried about B's token cost
  (larger tool definitions → higher cache cost) and about qualitative friction from
  annotation-derived tools; it did not anticipate that the *hand-written* tool's own
  pagination cursor would fail its own output validation when fed back into itself. That
  one bug (not two — the search "bug" turned out to be a shared, benign keyword-OR
  matching quirk once the same transcript's own evidence, call 8, was checked) is a real
  defect in arm A, the tool set that was supposed to be the known-good baseline.
- The two token ratios did **not** diverge in this run, in aggregate — but the reason
  turns out to be mechanical (both scale with turn count, and B took ~21% fewer turns),
  not evidence that B's larger definitions are free of the structural risk the ratio
  warning describes. That warning is a controller ruling from Task 6 (recorded in the SDD
  progress ledger and as a comment in `evals/report.ts`), not a claim in this design doc's
  earlier text — worth being precise about, since a reader grepping this document for the
  warning's origin would not have found it before this correction. On the two scenarios
  where call counts were held equal between arms, the ratio the warning describes shows up
  exactly as predicted (B/A 1.35 and 1.24) — the aggregate result doesn't mean the warning
  was wrong, it means turn count dominated it this time.
- The dominant friction category (oversized `describe_dataset` responses against the SDK's
  own output-size cap) is not a parity question at all. It hits two different wide-schema
  datasets on this mechanism (`sirene` and `contours-des-communes`) across both arms — an
  earlier version of this write-up also counted `base-sirene-des-entreprises` here, which
  was wrong (see the Group 1 correction above: that call didn't hit the hard cap at all, it
  hit the SDK's separate persisted-output-preview path). It shows up as "friction" in the
  judge's rubric, but it's an SDK/dataset-width interaction, not a finding about
  annotations vs. hand-written tools.
  **Correction: this run's harness setup substantially inflates this category, and the
  affordance it seems to call for is the wrong fix.** `evals/isolation.ts` sets `tools: []`
  for both the runner and the judge, which is necessary isolation (it stops the SDK
  offering its own built-ins instead of the MCP tools under test) but has a side effect
  nothing in the design anticipated: it also makes the SDK's own overflow-recovery path
  unreachable. The capped-response error text tells the agent to go read the saved file
  with `offset`/`limit`/`jq`, but the agent in this harness has no Read, Grep or Bash tool
  to do that with — a normal coding-agent session has all three and would just read the
  file. The friction is therefore substantially a harness artifact, not a tool-design gap:
  it is symmetric across arms (both hit it, so it doesn't bias the B/A comparison this
  harness exists to produce), but it means phase 3 should **not** read this run as calling
  for a new large-schema summarisation/pagination affordance in the tools themselves — the
  problem this run demonstrates is largely "the harness removed the agent's normal recovery
  tools," which a normal session doesn't have.
- **The judge's own prompt construction is a confound the design didn't anticipate.**
  `evals/judge.ts` truncates any call response over 4,000 characters before the judge ever
  sees it. 9 of the run's 35 friction points sit on a truncated view, and at least one
  (`describe-dataset--B` call 2) was originally misdiagnosed as a tool defect purely
  because of that truncation — the tool's actual response was complete. The judge not
  being told which arm it's reading protects against one kind of bias, but says nothing
  about a systematic view-construction limitation that can apply unevenly (search-heavy
  scenarios, whose responses tend to be longer, saw this more).
- **Verdicts are not calibrated across arms, and `search-air-quality` demonstrates it
  directly.** The judge reads one transcript at a time with no visibility into how the
  other arm answered the same question. On this scenario, arm A and arm B reached the
  *literal same conclusion* — "no air-quality dataset exists on this platform" — using the
  same flawed search mechanism, yet the judge failed A and passed B, weighing hedged
  phrasing ("*ne semble pas proposer actuellement*") more than the underlying search
  quality both transcripts exhibit. A blind, one-at-a-time judge cannot catch that kind of
  cross-arm inconsistency by construction; only cross-checking, as this correction did by
  reading both verdicts side by side, surfaces it.
- **This is one run, at one runner tier, on 11 scenarios.** Both the pass-rate numbers
  (9/11 vs 11/11) and the token ratios (aggregate 0.87–0.88, per-scenario spread
  0.54–2.18) come from a single measurement per scenario per arm, against a live,
  timestamped, and therefore not perfectly reproducible data source, using the smallest
  runner tier (`haiku`) specifically because it's cheap enough to re-run. None of the
  numbers above should be read as more precise than "directionally, on this run" until a
  second run either reproduces or contradicts them.

### Tool examples: considered and deferred

Adding `x-agent.examples` to the six `explore` tools was the obvious next move — the
vocabulary supports it end to end, the MCP adapter emits it as
`_meta: { 'anthropic/inputExamples': … }`, and the data-fair annotation set declares none.
Anthropic reports examples taking complex parameter handling from 72% to 90%.

This run says not yet, for two reasons.

**Our arm shows no shape failures for examples to fix.** Sorting the run's rejections by
kind, the only malformed-argument errors are on the hand-written arm:

```
aggregation--A  call 3  sort: "\"-count\""   -> 400, field "-count" does not exist
aggregation--A  call 4  sort: "\"-metric\""  -> 400, field "-metric" does not exist
```

Both are one mistake — a doubly-quoted string where a plain one was wanted. The annotated
arm made none: its `filters` description already carries an inline example
(`{ "ville_eq": "Paris", "age_lte": "30", … }`) and it produced the right shape every time.
Examples would be insurance against a failure this baseline does not contain.

**The failures it does contain are ones examples cannot fix.** Every remaining rejection is
a guessed *column name* — `forme_juridique`, `commune_siege`, `ville`, `nom_rais_sociale` —
and those are per-dataset. No example can supply them. They trace to the capped
`describe_dataset` documented as item B1 in the data-fair agent-readiness notes: in every
scenario where a column was rejected, the schema had failed to load earlier in the same
transcript, and in no scenario did an agent read a schema successfully and then guess.

So a re-run with examples would mostly re-measure the schema-cap problem. The decision is
to revisit once B1 lands and that noise clears, at which point a before/after on examples
would measure examples. Recorded rather than dropped: the mechanism is built and tested,
only the annotations are unwritten.
