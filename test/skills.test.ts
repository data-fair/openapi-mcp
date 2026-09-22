import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildSkills, renderSkillFile } from '../src/skills.ts'

describe('buildSkills', () => {
  it('filters by the selected profiles and splits a first paragraph off as the description', () => {
    const skills = buildSkills([
      { name: 'workflow', description: { en: 'Start with list.\n\nThen filter.\nThen aggregate.', fr: 'Commencez.' }, tools: ['list', 'search'] },
      { name: 'editing', description: 'Only when asked.', profiles: ['edit'] }
    ], new Set(['explore']), 'en')
    assert.deepEqual(skills, [{
      id: 'workflow',
      name: 'workflow',
      description: 'Start with list.',
      body: 'Start with list.\n\nThen filter.\nThen aggregate.\n\nTools: list, search',
      tools: ['list', 'search'],
      profiles: undefined
    }])
  })
  it('caps the description at 1024 characters', () => {
    const [skill] = buildSkills([{ name: 'long', description: 'x'.repeat(2000) }], new Set(['explore']), 'en')
    assert.equal(skill.description.length, 1024)
  })
})

describe('renderSkillFile', () => {
  it('renders SKILL.md with quoted frontmatter, and a digest over its bytes', () => {
    const file = renderSkillFile({ id: 'data-fair/workflow', name: 'workflow', description: 'Say "hi": now', body: 'Body.' })
    assert.equal(file.uri, 'skill://data-fair/workflow/SKILL.md')
    assert.equal(file.text, '---\nname: workflow\ndescription: "Say \\"hi\\": now"\n---\n\nBody.\n')
    assert.deepEqual(file.frontmatter, { name: 'workflow', description: 'Say "hi": now' })
    assert.equal(file.size, Buffer.byteLength(file.text))
    assert.equal(file.digest, 'sha256:' + createHash('sha256').update(file.text).digest('hex'))
  })
})
