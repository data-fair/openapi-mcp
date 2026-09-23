import type { JsonSchema, ToolAnnotations, ToolSet } from './types.ts'

export interface ToolSetSnapshot {
  profiles: string[]
  tools: { name: string, description: string, inputSchema: JsonSchema, annotations: ToolAnnotations }[]
  skills: { id: string, name: string, description: string }[]
}

/**
 * The agent-facing surface of a tool set as plain data, for a committed golden: a service's
 * CI diffs it so an unintended change to a tool's name, description or schema is a
 * reviewable diff in the pull request that caused it. A golden file is what `JSON.stringify`
 * writes, so the snapshot is the JSON round-trip of the view below — no `undefined` survives.
 */
export function toolSetSnapshot (toolSet: ToolSet): ToolSetSnapshot {
  const snapshot = {
    profiles: [...toolSet.profiles],
    tools: toolSet.tools.map(t => ({ name: t.name, description: t.description, inputSchema: structuredClone(t.inputSchema), annotations: { ...t.annotations } })),
    skills: toolSet.skills.map(s => ({ id: s.id, name: s.name, description: s.description }))
  }
  return JSON.parse(JSON.stringify(snapshot))
}
