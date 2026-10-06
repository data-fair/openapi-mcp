import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { resolveSkills, renderSkillFile, skillEntries, skillUri, digestOf, defaultSkillFetcher } from '../src/skills.ts'
import type { SkillBodyFetcher } from '../src/types.ts'

const files: Record<string, string> = {
  'https://api.test/v1/agents/skills/a.md': '---\nname: a\ndescription: ignored\n---\n\n# A\n\nDo this.\n',
  'https://api.test/v1/agents/skills/b.fr.md': 'Faites ceci.',
  'https://cdn.test/c.md': 'Absolute.'
}
const fetchBody: SkillBodyFetcher = async (url) => url in files ? { text: files[url] } : { error: 'HTTP 404' }
const base = 'https://api.test/v1/api-docs.json'

describe('resolveSkills', () => {
  it('reads an inline body, a linked body (frontmatter stripped), and falls back to the description', async () => {
    const skills = await resolveSkills([
      { name: 'inline', description: 'When inline.', body: 'Inline body.', tools: ['t1', 't2'] },
      { name: 'a', description: 'When a.', href: 'agents/skills/a.md' },
      { name: 'plain', description: 'Just this.' }
    ], new Set(['explore']), 'en', base, fetchBody)
    assert.deepEqual(skills.map(s => [s.id, s.description, s.body]), [
      ['inline', 'When inline.', 'Inline body.\n\nTools: t1, t2'],
      ['a', 'When a.', '# A\n\nDo this.'],
      ['plain', 'Just this.', 'Just this.']
    ])
    assert.equal(skills[1].digest, digestOf('# A\n\nDo this.'))
    assert.equal(skills[1].error, undefined)
  })
  it('resolves a localized link and an absolute one', async () => {
    const skills = await resolveSkills([
      { name: 'b', description: 'd', href: { en: 'agents/skills/b.en.md', fr: 'agents/skills/b.fr.md' } },
      { name: 'c', description: 'd', href: 'https://cdn.test/c.md' }
    ], new Set(), 'fr', base, fetchBody)
    assert.deepEqual(skills.map(s => s.body), ['Faites ceci.', 'Absolute.'])
  })
  it('keeps an unreachable skill with its error, and filters by profiles', async () => {
    const skills = await resolveSkills([
      { name: 'gone', description: 'd', href: 'nope.md' },
      { name: 'edit-only', description: 'd', profiles: ['edit'] }
    ], new Set(['explore']), 'en', base, fetchBody)
    assert.deepEqual(skills.map(s => [s.id, s.body, s.error]), [['gone', '', 'HTTP 404 (https://api.test/v1/nope.md)']])
  })
  it('refuses a relative link without a base URL, as an error on the skill', async () => {
    const [skill] = await resolveSkills([{ name: 'a', description: 'd', href: 'a.md' }], new Set(), 'en', undefined, fetchBody)
    assert.match(skill.error!, /no base URL/)
  })
})

describe('resolveSkills — unresolvable links', () => {
  it('puts an error on the skill instead of throwing, for a relative base or a malformed link', async () => {
    const skills = await resolveSkills([
      { name: 'rel', description: 'd', href: 'w.md' },
      { name: 'bad', description: 'd', href: 'http://[' }
    ], new Set(), 'en', '/api/v1/', fetchBody)
    assert.deepEqual(skills.map(s => [s.id, s.body]), [['rel', ''], ['bad', '']])
    assert.match(skills[0].error!, /cannot resolve link w\.md against \/api\/v1\//)
    assert.match(skills[1].error!, /cannot resolve link http:\/\/\[/)
  })
})

describe('defaultSkillFetcher', () => {
  it('returns the text, or the HTTP status, or the network error', async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/ok.md')) return new Response('Body.', { headers: { 'content-type': 'text/markdown' } })
      if (url.endsWith('/missing.md')) return new Response('no', { status: 404 })
      throw new Error('ECONNREFUSED')
    }) as typeof fetch
    const f = defaultSkillFetcher(fetchFn)
    assert.deepEqual(await f('https://x.test/ok.md'), { text: 'Body.' })
    assert.deepEqual(await f('https://x.test/missing.md'), { error: 'HTTP 404' })
    assert.deepEqual(await f('https://x.test/down.md'), { error: 'fetch failed: ECONNREFUSED' })
  })
})

describe('skillEntries', () => {
  it('renders name, description, tools and the resource to read, never the body', async () => {
    const skills = await resolveSkills([{ name: 'w', description: 'When w.', body: 'SECRET BODY', tools: ['t1'] }], new Set(), 'en', base, fetchBody)
    const composed = skills.map(s => ({ ...s, id: 'svc/w' }))
    assert.equal(skillUri(composed[0]), 'skill://svc/w/SKILL.md')
    const text = skillEntries(composed)
    assert.equal(text, '## w\n\nWhen w.\n\nTools: t1\nRead it as the MCP resource skill://svc/w/SKILL.md.')
    assert.doesNotMatch(text, /SECRET/)
  })
})

describe('renderSkillFile', () => {
  it('renders SKILL.md with quoted frontmatter, and a digest over its bytes', () => {
    const file = renderSkillFile({ id: 'data-fair/workflow', name: 'workflow', description: 'Say "hi": now', body: 'Body.', digest: digestOf('Body.') })
    assert.equal(file.uri, 'skill://data-fair/workflow/SKILL.md')
    assert.equal(file.text, '---\nname: workflow\ndescription: "Say \\"hi\\": now"\n---\n\nBody.\n')
    assert.deepEqual(file.frontmatter, { name: 'workflow', description: 'Say "hi": now' })
    assert.equal(file.size, Buffer.byteLength(file.text))
    assert.equal(file.digest, 'sha256:' + createHash('sha256').update(file.text).digest('hex'))
  })
})
