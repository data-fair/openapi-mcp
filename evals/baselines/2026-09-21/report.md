# Baseline: 2026-09-21

Runner model: `haiku` (`OPENAPI_MCP_EVAL_MODEL`, default). Judge model: `sonnet`
(`OPENAPI_MCP_EVAL_JUDGE_MODEL`, default). Portal: `https://opendata.koumoul.com` (live).

- Arm A provenance: `/home/alban/data-fair/mcp`, version `0.7.5`, commit `9a92dc9`.
- Arm B provenance: frozen annotated fixture, `fixtureHash 75d4825320c6`, `explore` profile.

Full analysis: `docs/superpowers/specs/2026-09-19-eval-harness-design.md`, `## First run`.

---


> @data-fair/openapi-mcp@0.1.0 eval:report
> node evals/report.ts

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

arm A: 9/11 satisfactory, 737644 tokens
arm B: 11/11 satisfactory, 640600 tokens
friction points: A 20, B 15
B/A token ratio: 0.87 (criterion: ≤ 1.2)
B/A input+output token ratio (excludes cache; headline above includes it): 0.88 — input+output tokens: A 31930, B 28104
tool definitions: A 7 tools, 10899 bytes; B 6 tools, 15136 bytes
