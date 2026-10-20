# Editor tool groups

`x-agent.editor` on a write operation turns it into eight [json-layout](https://github.com/json-layout/json-layout)
form tools. Instead of submitting a whole request body, the agent edits a form session: it reads
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

Each tool takes the write operation's path parameters, so several documents can be edited at once.
Names are the operation's tool name, `_`, then the verb:

| Tool | Does |
| --- | --- |
| `<name>_describeState` | Every field's path, type, constraints, value and errors. Start here. |
| `<name>_getData` | The document, whole or one part by path. |
| `<name>_setFieldValue` | Sets one field. |
| `<name>_setData` | Sets several fields. |
| `<name>_getFieldSuggestions` | Accepted values of a field whose list is behind a request. |
| `<name>_editArray` | Adds or removes array items. |
| `<name>_saveForm` | Saves through the write operation; refused while the document is invalid. |
| `<name>_reloadForm` | Reloads, discarding local changes. |

Descriptions come from the package. Every tool carries the operation's security (or its narrowed
`security`), so `toolsForScopes` keeps or drops the group as a whole. The group also publishes its
fill-form skill, named after the tool name in kebab case.

## Sessions

A session is keyed by the caller's `identity`, the operation and all its path parameter values:
one form per caller and document, resumed by any call with the same parameters until
`reloadForm`. A save sends the whole document (PUT or POST); a failed one comes back as an
`isError` result with the API's message.

## The schema

`load`'s `prepareEditorSchema(schema)` adapts a form schema before json-layout compiles it: a
declared body or a fetched one, given as a copy. By default the schema is used as is. Sessions with
the same schema operation, path parameters and `schemaParams` share one schema source: each session
fetches it when it opens, and the compiled layout is reused while the body's hash is unchanged.

## Limitations

- JSON request bodies only.
- Whole-document saves, no patch.
- No precompiled layouts, no sub-agent mode.
