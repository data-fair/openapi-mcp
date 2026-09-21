# Editor tool groups

An `x-agent.editor` annotation on a write operation turns it into a group of eight
[json-layout](https://github.com/json-layout/json-layout) form tools. Instead of a single
tool that submits a whole request body, the agent gets a stateful form session: it can
inspect the form, set fields one at a time, fetch suggestions, edit arrays, and save when
the document is valid.

This is for APIs that edit structured documents — a dataset record, an application
configuration — where handing the agent the raw body schema is both bulky and error-prone.
The heavy lifting (session lifetime, save gate, optimistic concurrency, compiled-layout
cache) lives in [`@json-layout/agents`](https://www.npmjs.com/package/@json-layout/agents);
this library adapts an OpenAPI operation to it.

## Installation

`@json-layout/agents` and `@json-layout/core` (>= 2.10.0) are **optional peer
dependencies**:

```sh
npm install @json-layout/agents @json-layout/core
```

They are imported lazily, inside the function that needs them, so a consumer that only
builds read tools does not need them installed.

## The annotation

`editor` names up to two *other* operations by `operationId`:

```yaml
# PUT /datasets/{id}/lines/{lineId}
x-agent:
  profiles: [write]
  name: dataset_line
  title: { en: Edit a dataset record, fr: Éditer un enregistrement }
  editor:
    schemaOperation: readSchema
    schemaParams: { mimeType: application/schema+json, extension: 'true' }
    readOperation: readLine
```

```yaml
# POST /datasets/{id}/lines
x-agent:
  profiles: [write]
  name: dataset_new_line
  title: { en: Add a dataset record, fr: Ajouter un enregistrement }
  editor:
    schemaOperation: readSchema
    schemaParams: { mimeType: application/schema+json, extension: 'true' }
    # no readOperation — nothing to load: this is a create
```

- **`schemaOperation`** — the operation whose **response body is the JSON Schema** for
  this operation's request body. When absent, the schema is the one the document already
  declares, which is what `editor: true` means. Use that form when the declared body
  schema carries json-layout `layout` keywords; use `schemaOperation` when the schema
  comes from the API (dataset schemas do).
- **`schemaParams`** — fixed parameter values for the schema operation. Use it when the
  document does not say how to get a JSON Schema out of that operation (e.g. a `mimeType`
  the API needs but never declares).
- **`readOperation`** — the operation that loads the current document. When absent, the
  session starts from `{}` and makes no HTTP call: a create.

The write operation must declare an `application/json` request body; `load` fails at
build time otherwise, as it does when a named operation does not exist or needs a path
parameter the write operation does not supply. Path parameters are matched **by name**
across the three operations.

## The eight tools

Every tool takes the write operation's path parameters, so two records (or two datasets)
can be edited in one agent session without a "current form" mode. Tool names are the
operation's `x-agent.name` plus `_` plus the package's verb:

| Tool | What it does |
| --- | --- |
| `<name>_describeState` | Every field's path, type, constraints, current value and errors. Start here. |
| `<name>_getData` | The data document itself, whole or one part by path. |
| `<name>_setFieldValue` | Set one field by path. |
| `<name>_setData` | Set many fields in one call. |
| `<name>_getFieldSuggestions` | Accepted values for a field whose list is only behind a request. |
| `<name>_editArray` | Add or remove items in an array field. |
| `<name>_saveForm` | Persist the document through the write operation. Refuses while invalid. |
| `<name>_reloadForm` | Reload from the source, discarding local changes. |

Tool descriptions come from the package, so they track its behaviour.

## Sessions

A session is keyed by the write operation and **all** its path parameter values: one
form per record. Calling any tool with the same parameters resumes the same session, with
its unsaved edits; `reloadForm` discards them. In create mode the key is the dataset, so a
second "add a record" resumes the first draft.

Saving sends the whole document through the annotated write operation (PUT and POST
replace the document, so there is nothing to diff). The package's own validity gate
applies: `saveForm` refuses an invalid document and reports the errors, and this library
does not add a second gate. A failed save — no credentials, a validation error, a read-only
token — comes back as an `{ isError: true }` result carrying the API's message, never as a
throw.

## Schema preprocessing

A fetched schema is not handed to `compile` as-is. `prepareSchema` does what data-fair's
own line-editing form does before rendering:

1. `v2compat` from `@json-layout/core/compat/v2`, translating vjsf-v2 keywords
   (`x-fromUrl`, `x-itemsProp`, …) so pickers render as pickers;
2. normalizes a string `layout` into `{ comp: … }`;
3. hides attachment columns (`x-refersTo: http://schema.org/DigitalDocument`, unless
   already a text field) — an agent has no file to upload — and `x-extension` columns,
   which the API computes.

The form's schema is fetched once per schema operation and shared by every session built
on it, so editing two hundred records of one dataset compiles the layout once. The schema
function reports a version — a hash of the fetched body, or the operation id when the
schema is the declared request body — so a changed dataset invalidates the compiled
layout.

## Limitations

- **JSON request bodies only.** An editor over a `multipart/form-data` body is out of scope.
- **Whole-document saves.** There is no PATCH/diff mode: the write operation replaces the
  document.
- **No precompiled layouts.** `SessionSpec.layout` supports them, but no annotation names a
  compiled artifact yet.
- **Flat tool surface.** Sub-agent mode (`includeSubAgent`) and the fill-form skill tool
  stay off.
- Attachment and extension columns are hidden by `prepareSchema`, so they are not editable
  through the group.

## Example

```ts
import { load } from '@data-fair/openapi-mcp'

// The document must carry the editor annotation (see above).
const { tools } = await load(doc, { profile: 'write' })
const describe = tools.find(t => t.name === 'dataset_line_describeState')!
const set = tools.find(t => t.name === 'dataset_line_setFieldValue')!
const save = tools.find(t => t.name === 'dataset_line_saveForm')!

await describe.execute({ id: datasetId, lineId })
await set.execute({ id: datasetId, lineId, path: '/nom', value: 'Brest' })
await save.execute({ id: datasetId, lineId })
```
