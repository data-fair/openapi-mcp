import { createHash } from 'node:crypto'
import { localize } from './localize.ts'
import type { AgentSkill, ResolvedOperation, Skill, SkillBodyFetcher } from './types.ts'

const MAX_DESCRIPTION = 1024

/** `sha256:` + 64 lowercase hex over the UTF-8 bytes of `text`. */
export const digestOf = (text: string): string => `sha256:${createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`

/** The resource a skill is served at: what instructions entries point to. */
export const skillUri = (skill: Pick<Skill, 'id'>): string => `skill://${skill.id}/SKILL.md`

const withTools = (text: string, tools?: string[]) => tools?.length ? `${text}\n\nTools: ${tools.join(', ')}` : text

/** A served SKILL.md carries its own frontmatter, rebuilt from the entry; the file's is dropped. */
const stripFrontmatter = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '')

function resolveHref (href: string, base: string | undefined): string | undefined {
  try {
    return new URL(href).href
  } catch {
    return base ? new URL(href, base).href : undefined
  }
}

/** Fetches a linked body with the load-time fetch, reporting failures instead of throwing. */
export function defaultSkillFetcher (fetchFn: typeof fetch): SkillBodyFetcher {
  return async (url) => {
    try {
      const res = await fetchFn(url, { headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' } })
      if (!res.ok) return { error: `HTTP ${res.status}` }
      return { text: await res.text() }
    } catch (err: any) {
      return { error: `fetch failed: ${err?.message ?? err}` }
    }
  }
}

/**
 * The skills a profile set selects, from a document's or an index's `skills`, with their bodies:
 * inline, linked (resolved against `base`), or the description itself. A body that cannot be read
 * leaves the skill listed with an `error`, so a broken link never takes a service down.
 */
export async function resolveSkills (skills: AgentSkill[] | undefined, selected: Set<string>, locale: string, base: string | undefined, fetchBody: SkillBodyFetcher): Promise<Skill[]> {
  const out: Skill[] = []
  for (const skill of skills ?? []) {
    if (skill.profiles && !skill.profiles.some(p => selected.has(p))) continue
    const description = (localize(skill.description, locale) ?? '').trim()
    let text: string | undefined
    let error: string | undefined
    const href = localize(skill.href, locale)
    if (href) {
      const url = resolveHref(href, base)
      if (!url) {
        error = `relative link ${href} has no base URL to resolve against`
      } else {
        const res = await fetchBody(url)
        if ('error' in res) error = `${res.error} (${url})`
        else text = stripFrontmatter(res.text).trim()
      }
    } else {
      text = (localize(skill.body, locale) ?? description).trim()
    }
    const body = text === undefined ? '' : withTools(text, skill.tools)
    out.push({ id: skill.name, name: skill.name, description, body, digest: digestOf(body), tools: skill.tools, profiles: skill.profiles, ...(error ? { error } : {}) })
  }
  return out
}

/** Level 1 of the Agent Skills disclosure: what each skill is for, and the resource to read. Never a body. */
export function skillEntries (skills: Skill[]): string {
  return skills.map(s => {
    const tools = s.tools?.length ? `Tools: ${s.tools.join(', ')}\n` : ''
    return `## ${s.name}\n\n${s.description}\n\n${tools}Read it as the MCP resource ${skillUri(s)}.`
  }).join('\n\n')
}

/**
 * The skill of an editor group: the json-layout fill-form skill its session generated. Its
 * name is the group's tool prefix in kebab case; its description, the operation's title.
 */
export function editorSkill (op: ResolvedOperation, body: string, tools: string[], locale: string): Skill {
  const name = op.toolName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  const title = (localize(op.agent.title, locale) ?? op.summary ?? '').trim()
  const description = (title ? `${title}: how to use the ${op.toolName}_* form tools.` : `How to use the ${op.toolName}_* form tools.`)
    .slice(0, MAX_DESCRIPTION)
  const profiles = Array.isArray(op.agent.profiles) ? op.agent.profiles : undefined
  const text = body.trim()
  return { id: name, name, description, body: text, digest: digestOf(text), tools, ...(profiles ? { profiles } : {}) }
}

export interface SkillFile {
  uri: string
  frontmatter: { name: string, description: string }
  text: string
  /** `sha256:` + 64 lowercase hex over `text`'s UTF-8 bytes */
  digest: string
  size: number
}

/** The SKILL.md a host reads through `resources/read`, with the entry fields `skills/list` publishes. */
export function renderSkillFile (skill: Skill): SkillFile {
  const frontmatter = { name: skill.name, description: skill.description }
  // JSON.stringify yields a valid double-quoted YAML scalar; the name needs no quoting by its pattern.
  const text = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}\n`
  const bytes = Buffer.from(text, 'utf8')
  return {
    uri: skillUri(skill),
    frontmatter,
    text,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.length
  }
}
