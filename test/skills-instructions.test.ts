import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderSkillFile } from '../src/skills.ts'
import { serverOptions, clientDeclaresSkills } from '../src/adapters/mcp.ts'

const skill = { id: 'svc/workflow', name: 'workflow', description: 'How to explore', body: 'Read the schema first.', digest: 'x', tools: ['list_datasets', 'get_schema'] }

describe('skill frontmatter', () => {
  it('a skill naming tools carries them in its frontmatter metadata', () => {
    const file = renderSkillFile(skill as any)
    assert.deepEqual(file.frontmatter, { name: 'workflow', description: 'How to explore', metadata: { tools: 'list_datasets get_schema' } })
    assert.match(file.text, /^---\nname: workflow\ndescription: "How to explore"\nmetadata:\n {2}tools: "list_datasets get_schema"\n---\n/)
  })

  it('a skill naming no tools has no metadata', () => {
    const file = renderSkillFile({ ...skill, tools: undefined } as any)
    assert.deepEqual(file.frontmatter, { name: 'workflow', description: 'How to explore' })
  })
})

const toolSet = { tools: [], skills: [], instructions: '## workflow\n\nRead it as the MCP resource skill://svc/workflow/SKILL.md.\n\nGuide text.', guideInstructions: 'Guide text.' }

describe('instructions for skills-aware clients', () => {
  it('keep the skill index for a client that does not declare skills', () => {
    assert.equal(serverOptions(toolSet as any, 1000).instructions, toolSet.instructions)
  })

  it('drop the skill index for a client that declares skills', () => {
    assert.equal(serverOptions(toolSet as any, 1000, { skillsAware: true }).instructions, 'Guide text.')
  })
})

const initialize = (capabilities: unknown) => new Request('http://x/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'c', version: '1' } } })
})

describe('clientDeclaresSkills', () => {
  it('an initialize declaring the extension is skills-aware, and the request body stays readable', async () => {
    const req = initialize({ extensions: { 'io.modelcontextprotocol/skills': {} } })
    assert.equal(await clientDeclaresSkills(req), true)
    assert.equal((await req.json()).method, 'initialize')
  })

  it('an initialize without it, a non-initialize request and no request are not', async () => {
    assert.equal(await clientDeclaresSkills(initialize({})), false)
    assert.equal(await clientDeclaresSkills(new Request('http://x/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' })), false)
    assert.equal(await clientDeclaresSkills(undefined), false)
  })
})
