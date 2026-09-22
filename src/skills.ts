import { createHash } from 'node:crypto'
import { localize } from './localize.ts'
import type { AgentSkill, Skill } from './types.ts'

const MAX_DESCRIPTION = 1024

/** The text-only skills a profile set selects, from a document's or an index's `skills`. */
export function buildSkills (skills: AgentSkill[] | undefined, selected: Set<string>, locale: string): Skill[] {
  const out: Skill[] = []
  for (const skill of skills ?? []) {
    if (skill.profiles && !skill.profiles.some(p => selected.has(p))) continue
    const text = (localize(skill.description, locale) ?? '').trim()
    const description = text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION)
    const body = skill.tools?.length ? `${text}\n\nTools: ${skill.tools.join(', ')}` : text
    out.push({ id: skill.name, name: skill.name, description, body, tools: skill.tools, profiles: skill.profiles })
  }
  return out
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
    uri: `skill://${skill.id}/SKILL.md`,
    frontmatter,
    text,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.length
  }
}
