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
  load.ts       ToolSet construction
  context.ts    per-call context (fetch, headers, identity)
  skills.ts     Skill objects and SKILL.md rendering
  snapshot.ts   toolSetSnapshot for per-service goldens
  scopes.ts     toolsForScopes: the tools a token's scopes reach
  input.ts      input schema derivation
  request.ts    serialization → Request
  multipart.ts  multipart (form-data) / raw file bodies with an exact length
  files.ts      file inputs: the file store's URLs only, bounds
  file-link.ts  file outputs: resource links
  render.ts     projection + markdown renderer
  editor/       json-layout form tool groups (optional peers, lazily imported)
  adapters/     mcp.ts — MCP SDK v2, both protocol eras, skills extension
  bin/          standalone MCP server (one document, loaded once)
test/           fixtures/ (annotated data-fair root doc, golden renders)
docs/           stable documentation (this repo's product docs)
docs/superpowers/  the process archive: specs, implementation plans, working notes
```

`docs/` at its root is for documentation that should outlive a phase: the `x-agent`
vocabulary reference and the editor tool groups guide. `docs/superpowers/` holds the
design process — specs, plans, live-check notes — kept for the reasoning, not as product
documentation.

## Releasing

1. `npm run quality && npm run build`
2. Bump `version` in `package.json` and commit.
3. `npm publish` (scoped public package: `publishConfig.access` is already set).
4. `git tag v<version> && git push --follow-tags`

The package publishes `dist/` and `skills/`; `README.md`, `LICENSE` and `package.json` are
included by npm automatically. `prepublishOnly` runs the build.
