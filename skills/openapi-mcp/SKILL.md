---
name: openapi-mcp
description: >
  Use when writing, reviewing or debugging `x-agent` annotations in an OpenAPI 3.x document for
  @data-fair/openapi-mcp: which operations become MCP tools, their names and descriptions, scopes
  and security narrowing, skills and tag guides, parameter overrides, response projections,
  request body shaping, files, and json-layout editor groups. Triggers include "annotate this
  OpenAPI with x-agent", "expose this API as MCP tools", an annotation lint error, a document that
  validates but produces no tools, or a tool offered to the wrong scopes.
---

# Annotating OpenAPI documents with `x-agent`

`@data-fair/openapi-mcp` turns an OpenAPI 3.x document into MCP tools. An operation becomes a tool
only when it carries `x-agent`, and the annotation decides everything an agent sees of it. The
reference is [`docs/x-agent.md`](https://github.com/data-fair/openapi-mcp/blob/main/docs/x-agent.md);
this is the working guide.

## At a glance

| Where | Keys |
| --- | --- |
| Document root | `skills` (`name`, `description`, `body` or `href`, `tools`) |
| `tags[]` entry | `guide` |
| Operation | `name`, `title`, `description`, `examples`, `annotations`, `params`, `fixed`, `body`, `bodyFields`, `bodyRequired`, `response`, `editor`, `security`; or an array of such views |
| Parameter definition | the overrides of `params.<name>` |
| Response schema property | `hint`, `exclude` |

Every agent-facing string is a string or a locale map. The vocabulary is validated by a JSON
schema: an unknown key fails with its JSON path.

## Annotating an operation

1. **Choose the operations.** Every tool competes for the agent's attention: annotate the
   operations that answer real questions, not every route.

2. **Name and describe.** `name` defaults to the snake_case `operationId`. Write the description
   for an agent, and say what the tool is not for when a sibling is close:

   ```yaml
   x-agent:
     name: search_articles
     description: Find articles by text and filters. Not for counts: use count_articles.
   ```

3. **Check the security.** A tool carries its operation's `security` (else the root's).
   `toolsForScopes(toolSet, scopes)` keeps it when an `oauth2` alternative's scopes are all in the
   token's, or an alternative is public. Membership is exact: list every accepted scope as its own
   alternative. No security anywhere: no scoped token is offered the tool.

4. **Tune the parameters.**

   ```yaml
   params:
     q: { name: query, description: Full-text search. }
     size: { maximum: 100, default: 12 }
     debug: { exclude: true }
   fixed: { format: json }
   ```

5. **Shape the response.** Wide JSON is where agents spend their context:

   ```yaml
   response:
     rows: /results
     concise: [id, title, updatedAt]
     detailed: [id, title, summary, updatedAt]
     selectParam: select   # a `fields` parameter generated from the response schema
     hints: /meta/hints    # the API's advice, shown after the rest
   ```

6. **Shape the body.** `bodyFields` allow-lists the properties a tool sends; `bodyRequired` makes
   some required for this tool; `body: compact` replaces a huge body schema with a listing, still
   validated locally.

7. **Files.** Uploads need no annotation: multipart `format: binary` parts and raw bodies become
   URL inputs, fetched only from the configured file store (`files.urlPrefixes`). A download is
   `response: { file: true }` on a GET, returning a link.

8. **Load it.**

   ```ts
   const toolSet = await load(doc, { lint: 'error' })
   console.log(toolSet.tools.map(t => t.name), toolsForScopes(toolSet, ['articles:read']).tools.map(t => t.name))
   ```

## Descriptions must agree with their schema

The agent follows the description and the schema refuses what disagrees. `load` lints the
descriptions an annotation authored and fails on a quoted scalar example for an array parameter
(show `["x"]`), on "comma-separated" for an array parameter (the serializer adds the commas), and
on a quoted value outside the enum. Fix the description; `lint: 'warn'` is for documents you cannot
edit.

## One operation, several tools: views

```yaml
patch:
  operationId: patchArticle
  security: [{ oauth2: [articles:write] }, { oauth2: [articles:admin] }]
  x-agent:
    - { name: update_article, bodyFields: [title, body] }
    - { name: publish_article, bodyFields: [published], security: [{ oauth2: [articles:admin] }] }
```

Each view is a tool with its own name. A view's `security` narrows the operation's, so a token the
API would refuse is not offered the tool; it can only drop alternatives. Prefer `bodyFields` to
trusting an agent to leave fields alone: a field the API adds later is offered by no tool until
named.

## Editor groups

`editor` on a write operation with a JSON body makes eight form tools instead of one: the agent
edits a json-layout session and saves a valid document.

```yaml
put:
  operationId: updateItem
  x-agent:
    name: item
    editor: { schemaOperation: readItemSchema, readOperation: readItem }
```

`schemaOperation` returns the JSON Schema (absent: the declared body); `readOperation` loads the
document (absent: a create). Named operations take only path parameters of the write operation,
by name. Install `@json-layout/agents`. See
[`docs/editor-tool-groups.md`](https://github.com/data-fair/openapi-mcp/blob/main/docs/editor-tool-groups.md).

## A golden in CI

```ts
const toolSet = await load(buildApiDocs(), { lint: 'error' })
assert.deepEqual(toolSetSnapshot(toolSet), JSON.parse(readFileSync('test/agent-surface.json', 'utf8')))
```

A renamed tool, a widened schema or a changed security becomes a diff in review. Asserting the tool
names `toolsForScopes` keeps for each scope set worth checking covers who is offered what.

## Failure modes

| Symptom | Cause |
| --- | --- |
| No tools | No `x-agent`, or no security alternative the scopes reach |
| A scoped token gets nothing for an operation | No security on the operation or the root |
| `x-agent invalid at /paths/…` | A typo, or a key at the wrong place |
| Lint error on a description | The description contradicts the schema: fix the description |
| `editor` fails at load | A named operation is missing, or needs a path parameter the write operation lacks |
| An upload tool is missing | No file store configured, or the part is not declared as a file |
| `selectParam … declares no properties` | The response schema is a stub |
| `x-agent security alternative … is not in the operation's security` | A view widens instead of narrowing |
