# Contributing

## Development

Node 24 is required (`.nvmrc`). Tests run TypeScript directly through Node's native type
stripping; there is no build step for them.

```sh
npm install
npm run quality   # eslint + tsc + node --test
npm run build     # tsc -p tsconfig.build.json → dist/
```

`npm run quality` is the gate before every commit. `npm run lint-fix` fixes lint issues.

Layout:

```
src/
  vocabulary/   x-agent JSON schema, validation, annotation lint
  spec.ts       OpenAPI loading, $ref inlining, operation resolution
  profiles.ts   includes expansion, profile-set selection
  load.ts       ToolSet construction
  context.ts    per-call context (fetch, headers, identity)
  skills.ts     Skill objects and SKILL.md rendering
  snapshot.ts   toolSetSnapshot for per-service goldens
  index-contract.ts  the deployment index document
  compose.ts    index → composer → compositions
  input.ts      input schema derivation
  request.ts    serialization → Request
  render.ts     projection + markdown renderer
  editor/       json-layout form tool groups (optional peers, lazily imported)
  adapters/     mcp.ts — MCP SDK v2, both protocol eras, skills extension
  bin/          standalone MCP server (single document or index)
test/           fixtures/ (annotated data-fair root doc, golden renders)
evals/          scenarios.json, harness, baselines/
docs/           stable documentation (this repo's product docs)
docs/superpowers/  the process archive: specs, implementation plans, working notes
```

`docs/` at its root is for documentation that should outlive a phase: the `x-agent`
vocabulary reference and the editor tool groups guide. `docs/superpowers/` holds the
design process — specs, plans, live-check notes — kept for the reasoning, not as product
documentation.

## Evaluating

An eval harness compares this project's annotation-derived tools against the hand-written
`data-fair/mcp` tool set on the same scenarios, judged blind to which arm produced each
transcript. Design and results:
[`docs/superpowers/specs/2026-09-19-eval-harness-design.md`](docs/superpowers/specs/2026-09-19-eval-harness-design.md).

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

## Releasing

1. `npm run quality && npm run build`
2. Bump `version` in `package.json` and commit.
3. `npm publish` (scoped public package: `publishConfig.access` is already set).
4. `git tag v<version> && git push --follow-tags`

The package publishes `dist/` and `skills/`; `README.md`, `LICENSE` and `package.json` are
included by npm automatically. `prepublishOnly` runs the build.
