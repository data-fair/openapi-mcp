# Editor tool groups

`x-agent.editor` on a write operation makes it a form of the document's eight
[json-layout](https://github.com/json-layout/json-layout) form tools: one group per document, whatever
the number of editor operations, the form chosen per call. Instead of submitting a whole request body, the agent edits a form session: it reads
the form, sets fields, asks for suggestions, edits arrays, and saves once the document is valid.
Sessions, the save gate and the compiled-layout cache live in
[`@json-layout/agents`](https://www.npmjs.com/package/@json-layout/agents); this library adapts an
operation to it.

## Installation

`@json-layout/agents` is an optional peer dependency, imported only when a document has an editor
annotation:

```sh
npm install @json-layout/agents
```

## The annotation

```yaml
# PUT /collections/{id}/items/{itemId}
x-agent:
  name: item
  title: { en: Edit an item }
  editor:
    schemaOperation: readItemSchema
    schemaParams: { format: json-schema }
    readOperation: readItem
```

- `schemaOperation`: the operation whose response body is the JSON Schema of the request body.
  Absent (or `editor: true`), the schema is the declared request body.
- `schemaParams`: fixed parameter values for that operation.
- `readOperation`: the operation loading the current document. Absent, the session starts from
  `{}` with no request: a create.

The write operation needs an `application/json` request body. A named operation must exist, and
may only ask for path parameters the write operation has, matched by name. Both are checked at load.

## The tools

The editor operations of a document share eight tools, named `form_` then the verb. Each takes
`form`, an enum of the operations' tool names (its description lists each with its title), the
path parameters of every form, merged by name, and the verb's own arguments. An editor operation's x-agent `description` goes to the skill's list of forms, not to the tools:

| Tool | Does |
| --- | --- |
| `form_describeState` | Every field's path, type, constraints, value and errors. Start here. |
| `form_getData` | The document, whole or one part by path. |
| `form_setFieldValue` | Sets one field. |
| `form_setData` | Sets several fields. |
| `form_getFieldSuggestions` | Accepted values of a field whose list is behind a request. |
| `form_editArray` | Adds or removes array items. |
| `form_saveForm` | Saves through the write operation; refused while the document is invalid. |
| `form_reloadForm` | Reloads, discarding local changes. |

A path parameter every form has is required; one only some forms have says which in its
description, and a call is refused when it misses one its form needs or passes one its form does
not take. A parameter's description is its x-agent override, else the document's. A name whose meaning differs per form gets one description per form (portals: `for "portal_config": Id of the portal; for "page_config": Id of the page.`), and differing
schemas an `anyOf`. A plain operation whose tool is named like a form tool fails the load.

The group is per loaded document, so a document merging several services' operations (data-fair's
platform document, whose tool names carry each service's prefix) has one group for all of them: the
tools stay `form_<verb>` and the forms take the merged tool names (`form: "portals_page_config"`),
and its skill is `form` too. Another skill named `form` beside it is a clash for whoever composes them.

Descriptions come from the package, with the form title taken out ("Describe the form: …"): the
form is the call's `form`, which an approval card shows among the arguments, and which the
package's own results name (`Saved "Brouillon de page"`). `describeState`, `getData` and
`getFieldSuggestions` are annotated `readOnlyHint: true`, the other five `false`. `openWorldHint`
merges the write operations' own: `true` when one form says so, `false` when all do, else unsaid
(open, by MCP's default). `annotations.title` is `<operation title> — <verb label>` while the tool
offers one form, `Formulaire — <verb label>` (`Form — …`) while it offers several (`FORM_VERB_LABELS`,
french when the locale is fr, english otherwise).

`security` is every form's alternatives, and each tool has a `forScopes` hook that `toolsForScopes`
calls instead: the tool comes back with `form` narrowed to the forms the scopes grant (and its title,
openWorldHint and path parameters recomputed from them), or not at all when none is granted. A call
naming a form outside the enum is refused.

The group publishes one skill, `form`: the package's fill-form guide, the list of forms with their
path parameters, and an `About <title> (form: "<name>")` section for each form whose declared schema
carries an `x-agent-guide`. Its tools are the eight, so it goes with them.

## Sessions

A session is keyed by the caller's `identity`, the form (its operation) and all its path parameter
values: one session per caller, form and document, resumed by any call with the same `form` and
parameters until `reloadForm`. A save sends the whole document (PUT or POST); a failed one comes back as an
`isError` result with the API's message.

After a successful save, a response body that is the saved document goes back to the session as
the server's copy (`@json-layout/agents` ≥ 0.5): when the server changed fields (derived,
normalized, stamped), the form takes its copy and the save result names the changed JSON pointers
(`the server changed 2 field(s) while saving: /theme/colors/primary, …`, ten at most). When the
response has no body or is another resource (an acknowledgment, an envelope: fewer than half of
the top-level keys shared with what was sent), the form keeps what was sent and the result of a
document's save says to call `form_reloadForm` with its `form` to read what the server stored. A session that creates
records empties its form after each save either way.

## The schema

`load`'s `prepareEditorSchema(schema)` adapts a form schema before json-layout compiles it: a
declared body or a fetched one, given as a copy. By default the schema is used as is. Sessions with
the same schema operation, path parameters and `schemaParams` share one schema source: each session
fetches it when it opens, and the compiled layout is reused while the body's hash is unchanged.

## Limitations

- JSON request bodies only.
- Whole-document saves, no patch.
- No precompiled layouts, no sub-agent mode.
