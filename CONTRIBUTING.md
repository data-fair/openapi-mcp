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
  files.ts      file inputs from the file store
  multipart.ts  upload bodies with an exact length
  file-link.ts  file outputs as links
  skills.ts     skills and SKILL.md
  scopes.ts     toolsForScopes
  snapshot.ts   toolSetSnapshot
  context.ts    per-call context
  editor/       json-layout form groups
  adapters/     mcp.ts (public), server.ts: the MCP server of a tool set
  bin/          the standalone server
test/
docs/           the vocabulary reference and the editor guide
skills/         the coding-agent skill, published with the package
```

## Releasing

1. `npm run quality`
2. Bump `version` in `package.json` and commit.
3. `npm publish` (runs the build).
4. `git tag v<version> && git push --follow-tags`
