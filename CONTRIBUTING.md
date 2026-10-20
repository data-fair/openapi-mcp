# Contributing

Node 24 is required. Tests run the TypeScript sources directly.

```sh
npm install
npm run quality   # eslint, tsc, node --test
npm run build     # dist/
```

```
src/
  vocabulary/   the x-agent JSON schema, its validation, the description lint
  spec.ts       loading, $ref inlining, annotation checks, operation resolution
  load.ts       the tool set
  input.ts      input schemas
  request.ts    requests
  render.ts     responses as markdown
  schema-summary.ts  compact body listings
  files.ts      file inputs from the file store
  multipart.ts  upload bodies with an exact length
  file-link.ts  file outputs as links
  skills.ts     skills and SKILL.md
  scopes.ts     toolsForScopes
  snapshot.ts   toolSetSnapshot
  context.ts    per-call context
  localize.ts   localized text
  editor/       json-layout form groups
  adapters/     mcp.ts (public), server.ts: the MCP server of a tool set
  bin/          the standalone server
test/
evals/          judged agent scenarios over the binary, baselines/
docs/           the vocabulary reference and the editor guide
skills/         the coding-agent skill, published with the package
```

## Evaluating

Unit tests check what a tool is; the evals check that an agent uses the tools well. Each scenario
in `evals/scenarios.json` is a question an agent answers with the tools this repository's binary
serves from a frozen annotated document (`test/fixtures/data-fair-root.json`, its data live on
the instance its `servers` names). A judge model then reads each transcript on its own and records
a verdict and the friction points the tools caused.

```sh
npm run eval:run      # every scenario (or: node evals/run.ts <id>…), into evals/runs/
npm run eval:judge    # judge every transcript in evals/runs/
npm run eval:report   # the table and totals; node evals/report.ts <baselineDir> compares with a baseline
```

`OPENAPI_MCP_EVAL_MODEL` (default `haiku`) is the agent's model, `OPENAPI_MCP_EVAL_JUDGE_MODEL`
(default `sonnet`) the judge's. A run costs model calls and queries a live instance: it is not
part of `npm test`. Run it when a change affects what an agent reads (descriptions, input schemas,
rendering, skills) and compare with `evals/baselines/`, adding a baseline when the change is kept.

## Releasing

1. `npm run quality`
2. `npm version <patch|minor|major>` (commits the version and tags it).
3. `npm publish` (runs the build).
4. `git push --follow-tags`
