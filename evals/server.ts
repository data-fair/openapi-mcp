/**
 * The MCP server under evaluation: this repository's binary over the fixture document.
 *
 * `allowedTools` comes from a real tools/list call rather than a hardcoded list: a name that
 * drifts does not fail, it silently becomes a DENIED tool, which reads in the transcript like a
 * tool the agent chose not to use.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export interface ServerSpec {
  name: string
  config: { command: string, args: string[], env: Record<string, string> }
  provenance: Record<string, string>
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export function serverSpec (openapiUrl: string, fixtureHash: string): ServerSpec {
  return {
    name: 'api',
    config: { command: 'node', args: [resolve(repoRoot, 'src/bin/server.ts')], env: { OPENAPI_URL: openapiUrl } },
    provenance: { fixtureHash }
  }
}

export interface Discovered { toolNames: string[], allowedTools: string[], definitionBytes: number, instructionsBytes: number }

/** The tools and the size of what every run sends before its first turn: definitions and instructions. */
export async function discoverTools (spec: ServerSpec): Promise<Discovered> {
  const transport = new StdioClientTransport({
    command: spec.config.command,
    args: spec.config.args,
    env: { ...process.env, ...spec.config.env } as Record<string, string>
  })
  const client = new Client({ name: 'eval-discovery', version: '0.0.0' })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    const toolNames = tools.map(t => t.name)
    return {
      toolNames,
      allowedTools: toolNames.map(n => `mcp__${spec.name}__${n}`),
      definitionBytes: JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).length,
      instructionsBytes: (client.getInstructions() ?? '').length
    }
  } finally {
    await client.close()
  }
}
