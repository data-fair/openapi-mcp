/**
 * The two arms. They differ in exactly one thing: the MCP server behind them.
 *
 * `allowedTools` is derived from a real tools/list call rather than a hardcoded list,
 * because a hardcoded name that drifts does not fail — it silently becomes a DENIED tool,
 * and a denied tool looks in the transcript like a tool the agent chose not to use.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export type ArmName = 'A' | 'B' | 'C'

export interface ArmSpec {
  name: ArmName
  serverName: string
  config: { command: string, args: string[], env: Record<string, string> }
  provenance: Record<string, string>
}

/** Both arms register under the same server name, so tool prefixes never identify the arm to the judge. */
const SERVER_NAME = 'datafair'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export function armA (portalUrl: string, checkoutPath = process.env.DATA_FAIR_MCP ?? join(homedir(), 'data-fair/mcp')): ArmSpec {
  const entry = join(checkoutPath, 'index.ts')
  if (!existsSync(entry)) {
    throw new Error(`arm A: data-fair/mcp checkout not found at ${checkoutPath} (set DATA_FAIR_MCP to override)`)
  }
  let version = 'unknown'
  try { version = JSON.parse(readFileSync(join(checkoutPath, 'package.json'), 'utf8')).version } catch { /* recorded as unknown */ }
  let commit = 'unknown'
  try { commit = execFileSync('git', ['-C', checkoutPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* recorded as unknown */ }

  return {
    name: 'A',
    serverName: SERVER_NAME,
    config: {
      command: 'node',
      args: [entry],
      env: {
        PORTAL_URL: portalUrl,
        TRANSPORT: 'stdio',
        // The `config` package resolves its config directory from process.cwd(), but this
        // server is spawned from this repo's cwd, not the checkout's. McpStdioServerConfig
        // (what Task 4's runner hands the SDK) has no `cwd` field, only `env` — so an env
        // override is the only route that works for both StdioClientTransport here and the
        // SDK's mcpServers there.
        NODE_CONFIG_DIR: join(checkoutPath, 'config')
      }
    },
    provenance: { source: checkoutPath, version, commit }
  }
}

export function armB (openapiUrl: string, fixtureHash: string): ArmSpec {
  return {
    name: 'B',
    serverName: SERVER_NAME,
    config: {
      command: 'node',
      args: [resolve(repoRoot, 'src/bin/server.ts')],
      env: { OPENAPI_URL: openapiUrl, PROFILES: 'explore' }
    },
    provenance: { fixtureHash, profile: 'explore' }
  }
}

/** The same document reached through an index and the composer: parity with B is the expectation. */
export function armC (indexUrl: string, fixtureHash: string): ArmSpec {
  return {
    name: 'C',
    serverName: SERVER_NAME,
    config: {
      command: 'node',
      args: [resolve(repoRoot, 'src/bin/server.ts')],
      env: { INDEX_URL: indexUrl, PROFILES: 'explore', REFRESH_INTERVAL: '0' }
    },
    provenance: { fixtureHash, profiles: 'explore', composed: 'true' }
  }
}

export async function discoverTools (arm: ArmSpec): Promise<{ toolNames: string[], allowedTools: string[], definitionBytes: number, instructionsBytes: number }> {
  const transport = new StdioClientTransport({
    command: arm.config.command,
    args: arm.config.args,
    env: { ...process.env, ...arm.config.env } as Record<string, string>
  })
  const client = new Client({ name: 'eval-discovery', version: '0.0.0' })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    const toolNames = tools.map(t => t.name)
    // The server's `instructions` block is sent through the protocol on every run, same as
    // the tool definitions — the spec counts it as part of the static preamble under
    // comparison, so it belongs alongside definitionBytes, not left out of the count.
    const instructions = client.getInstructions() ?? ''
    return {
      toolNames,
      allowedTools: toolNames.map(n => `mcp__${arm.serverName}__${n}`),
      definitionBytes: JSON.stringify(tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).length,
      // `.length`, not a byte count — same (carried-forward, not-to-fix) convention as
      // definitionBytes above, so the two stay directly comparable/addable.
      instructionsBytes: instructions.length
    }
  } finally {
    await client.close()
  }
}
