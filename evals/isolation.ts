/**
 * The isolation guarantee.
 *
 * Measured, not assumed, in data-fair/agents' lib-sim: with `settingSources: []` but the
 * repository as cwd, the model answered from the project's auto-memory index — naming the
 * very things the harness exists to measure. Auto-memory is keyed to the project
 * directory, so only a neutral cwd removes it. `tools: []` matters as much: without it the
 * SDK offers its own built-ins and the model reaches for those instead of the MCP tools
 * under test.
 *
 * These options are fixed. Nothing in a run may override them.
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

export type Env = Record<string, string | undefined>

/** Deliberately meaningless name: the cwd path reaches the model, so it must carry no signal. */
export function neutralCwd (): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eval-'))
}

export function scrubEnv (env: Env): Env {
  const scrubbed: Env = { ...env }
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith('CLAUDE_CODE_')) delete scrubbed[key]
  }
  return scrubbed
}

export function isolationOptions (cwd: string, env: Env = process.env) {
  return {
    cwd,
    env: scrubEnv(env),
    settingSources: [] as never[],
    tools: [] as never[],
    strictMcpConfig: true as const
  }
}
