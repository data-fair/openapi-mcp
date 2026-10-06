# Linked skills and progressive disclosure — design

Status: agreed 2026-10-06. Target release: 0.4.0 (breaking).

## Problem

A skill declared in `x-agent.skills` (or in an index's `skills`) carries its whole text in
`description`. The library then uses that text three times: rendered in full into the MCP
`instructions`, served as `skill://…/SKILL.md`, and — through a first-paragraph heuristic — as
the summary in the skills manifest. Two costs follow, and they grow with every skill a service
adds:

- the API document carries every skill's full text;
- every session pays the full text of every selected skill in its context, whether or not the
  task needs it.

The API document stays the place where skills are declared. What changes is where their bodies
live and when an agent reads them.

## Model: the Agent Skills levels

Native skills (the Agent Skills format behind Claude Code and the MCP skills extension) are
disclosed in three levels:

1. **Always loaded** — each skill's `name` and `description`. The description is what the model
   uses to decide whether the skill applies.
2. **On invocation** — the body of `SKILL.md`, frontmatter stripped. It does not repeat the
   description, which the model already read.
3. **On demand** — files the body points to.

This design implements levels 1 and 2. Level 3 is out of scope; nothing here prevents adding it
(for example a relative link in a body, resolved by `read_skill` with an optional path).

## 1. Vocabulary

```yaml
x-agent:
  skills:
    - name: catalog-workflow
      description: How to explore a portal's datasets. Use it before searching or aggregating data.
      href: agents/skills/catalog-workflow.md      # or { fr: …, en: … }
      profiles: [catalog]
      tools: [datafair_list_datasets, datafair_search_data]
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Agent Skills name, `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 64 characters (unchanged). |
| `description` | yes | Level 1: what the skill is for and when to use it. Localized. At most 1024 characters per locale — the Agent Skills limit — refused at validation otherwise. |
| `href` | no | Link to the body (markdown). Localized: a `{ fr, en }` map picks the link per locale. |
| `body` | no | Inline body (markdown). Localized. For short skills that do not deserve a file. |
| `profiles` | no | Unchanged. |
| `tools` | no | Unchanged; rendered as a `Tools:` line in the instructions entry and after the body. |

`href` and `body` are mutually exclusive (refused at validation). A skill with neither has its
description as its body.

No text is derived from paragraphs any more: the first-paragraph heuristic is removed.

The same fields apply to the index contract's `skills`.

**Breaking change.** Today's skills hold their full text in `description`; a description longer
than 1024 characters now fails validation with the JSON path of the skill, so every author gets
a clear error rather than silently changed behaviour. Migration: move the text into `body` or a
file referenced by `href`, and write a one- or two-sentence `description`.

Tag-level `x-agent.skill` texts are unchanged: they stay inline and rendered in the instructions,
next to the operations they explain.

## 2. Resolution

- A relative `href` resolves against the URL the document (or index) was fetched from. For a
  document passed as an object, it resolves against `servers[0].url` (or the `baseUrl` option).
  Absolute URLs are used as they are.
- `load()` fetches the bodies of the selected skills with the load-time `fetch` — the same
  credentials as the document — before returning.
- The composer caches bodies with conditional requests (ETag, Last-Modified), like documents, and
  revalidates them on `refresh()`. A changed body changes the tool set's snapshot, so listeners
  are notified as for a changed document.
- A body file may start with a YAML frontmatter block; it is stripped, since the served
  `SKILL.md` frontmatter is always rebuilt from the entry's `name` and `description`.
- A body that cannot be fetched (network error, non-2xx status) does not fail the service: the
  skill stays in the instructions and in `read_skill`, which answers with the error (URL and
  status); it is left out of the skills manifest and the resource list, which need a digest; the
  composer adds `skill <name>: <reason>` to the service status `warnings`, which the bundled
  server prints at startup.

## 3. What the agent sees

### Instructions

Every selected skill — document, index or editor group — becomes a short entry; no body is ever
rendered into the instructions:

```
## catalog-workflow
How to explore a portal's datasets. Use it before searching or aggregating data.
Tools: datafair_list_datasets, datafair_search_data
Read it with read_skill("data-fair/catalog-workflow").
```

The editor groups' sections (`## <tool>` + `Tools:`) take the same form, their skill's
description included.

### The `read_skill` tool

- Added by `load()` when the selected profiles yield at least one skill; a composition has exactly
  one, for the merged set (per-service ones are not merged).
- Fixed, unprefixed name `read_skill`. A service declaring an operation tool with that name falls
  under the existing collision rule: the service is excluded with an error status.
- Input `name`: one `const` per available skill id with its `description` —
  `{ "oneOf": [{ "const": "data-fair/catalog-workflow", "description": "…" }, …] }` — so level 1
  reaches the model through the tool definition in hosts that do not show server instructions.
- Output: the body as markdown, followed by the `Tools:` line when the skill lists tools. An
  unknown id or a body that could not be fetched returns `isError` with the reason.
- Annotations: `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`.

### Resources and the skills extension

Unchanged in shape: `skill://<id>/SKILL.md` resources, `skills/list`, `skills/get`. The served
`SKILL.md` is the entry's frontmatter (`name`, `description`) and the body. Skills whose body
failed are absent from both lists.

### Snapshot

`toolSetSnapshot` skill entries gain `digest` (`sha256:` over the body). `read_skill` appears among
the tools. A reworded skill file is a one-line digest diff in the owning service's golden; the body
itself is not copied into goldens, since the markdown file is in the same pull request.

## 4. Types

`AgentSkill` gains `href?: Localized` and `body?: Localized`. `Skill` (the resolved form) keeps
`id`, `name`, `description`, `body`, `tools`, `profiles` and gains `digest` and an optional `error`
(the fetch failure, when the body could not be resolved). `ServiceStatus.warnings` carries the
skill fetch failures alongside the vocabulary warnings.

## 5. Tests

Against a stubbed `fetch`:

- validation: `description` over 1024 characters refused with the skill's path; `href` and `body`
  together refused; both forms accepted in documents and in the index contract;
- resolution: relative to the document URL, relative to `servers[0].url`, absolute, localized
  `href`; frontmatter stripped;
- composer refresh: an ETag change in a body changes the digest and notifies listeners; an
  unchanged body is a 304 and notifies nothing;
- failure: warning on the service status, skill absent from `skills/list` and `resources/list`,
  `read_skill` answers `isError` naming the URL;
- instructions never contain a body; every entry names `read_skill`;
- `read_skill`: the `oneOf` lists every selected skill with its description, a composition has
  exactly one, a service tool named `read_skill` is a collision;
- snapshot: digests present, `read_skill` listed.

## 6. Out of scope

- Level 3 (files linked from a body).
- Moving data-fair's and metrics' skills to served markdown files: a follow-up in those
  repositories once 0.4.0 is released.
