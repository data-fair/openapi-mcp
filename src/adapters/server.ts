import { Server, fromJsonSchema, ProtocolError, INVALID_PARAMS, INTERNAL_ERROR, type ServerOptions, type CacheHint } from '@modelcontextprotocol/server'
import { renderSkillFile, skillEntries, skillUri, type SkillFile } from '../skills.ts'
import type { CallContext, ToolSet } from '../types.ts'

/** The MCP side of a tool set, for one caller. The public entry is ./mcp.ts. */

const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
export const DEFAULT_CACHE_TTL_MS = 300_000

/**
 * Whether the client listing this server declared the skills extension (SEP-2640) in its `initialize`.
 * Such a client lists skills itself, so the skill entries are left out of `instructions`. Read from a
 * clone: the handler reads the body afterwards. Never throws.
 *
 * The 2026-07-28 era sends no `initialize`: those clients get the full `instructions` until the SDK
 * hands the factory the request's client capabilities.
 */
export async function clientDeclaresSkills (request: Request | undefined): Promise<boolean> {
  if (!request || request.method !== 'POST') return false
  try {
    const message = await request.clone().json()
    const params = message?.method === 'initialize' ? message.params : undefined
    return !!params?.capabilities?.extensions?.[SKILLS_EXTENSION]
  } catch {
    return false
  }
}

/** The skill entries, unless the client lists skills itself, then the guides. */
export function instructions (toolSet: ToolSet, opts: { skillsAware?: boolean } = {}): string {
  const guides = toolSet.guides.map(g => `## ${g.name}\n\n${g.text}`)
  return [opts.skillsAware ? '' : skillEntries(toolSet.skills), ...guides].filter(Boolean).join('\n\n')
}

export function serverOptions (toolSet: ToolSet, cacheTtlMs: number, opts: { skillsAware?: boolean } = {}): ServerOptions {
  const hint: CacheHint = { ttlMs: cacheTtlMs, cacheScope: 'private' }
  const text = instructions(toolSet, opts)
  return {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, extensions: { [SKILLS_EXTENSION]: {} } },
    instructions: text || undefined,
    cacheHints: { 'tools/list': hint, 'resources/list': hint, 'resources/read': hint, 'server/discover': hint }
  }
}

const skillEntry = (s: SkillFile) => ({ uri: s.uri, frontmatter: s.frontmatter, resources: [{ uri: s.uri, digest: s.digest, size: s.size }] })

/** Register tools, resources and the skills extension on a low-level server, for one caller. */
export function toMcpServer (toolSet: ToolSet, server: Server, options: { ctx?: CallContext, cacheTtlMs?: number } = {}): void {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  // A skill whose body could not be read has no digest to publish in the manifest; its resource
  // stays listed and answers the error, so an agent following an instructions entry learns why.
  const skills = toolSet.skills.filter(s => !s.error).map(renderSkillFile)
  const byUri = new Map(skills.map(s => [s.uri, s]))
  const failed = new Map(toolSet.skills.filter(s => s.error).map(s => [skillUri(s), s]))

  server.setRequestHandler('tools/list', async () => ({
    tools: toolSet.tools.map(t => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as any,
      outputSchema: t.outputSchema as any,
      annotations: t.annotations,
      _meta: t.examples ? { 'anthropic/inputExamples': t.examples } : undefined
    }))
  }))
  server.setRequestHandler('tools/call', async (req) => {
    const tool = toolSet.tools.find(t => t.name === req.params.name)
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] }
    const result = await tool.execute(req.params.arguments ?? {}, options.ctx)
    // The text first: a client that ignores resource links still reads where the file is.
    const content: ({ type: 'text', text: string } | { type: 'resource_link', uri: string, name: string, mimeType?: string })[] = [{ type: 'text', text: result.text }]
    if (result.resourceLink) content.push({ type: 'resource_link', ...result.resourceLink })
    return {
      content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result.isError ? { isError: true } : {})
    }
  })
  server.setRequestHandler('resources/list', async () => ({
    resources: [
      ...skills.map(s => ({ uri: s.uri, name: s.frontmatter.name, description: s.frontmatter.description, mimeType: 'text/markdown' })),
      ...[...failed.entries()].map(([uri, s]) => ({ uri, name: s.name, description: s.description, mimeType: 'text/markdown' }))
    ]
  }))
  server.setRequestHandler('resources/read', async (req) => {
    const s = byUri.get(req.params.uri)
    const broken = failed.get(req.params.uri)
    if (broken) throw new ProtocolError(INTERNAL_ERROR, `The skill ${broken.name} could not be read: ${broken.error}`)
    if (!s) throw new ProtocolError(INVALID_PARAMS, `No resource is served at ${req.params.uri}`)
    return { contents: [{ uri: s.uri, mimeType: 'text/markdown', text: s.text }] }
  })
  // The extension's two methods, on the base Resources primitive (SEP-2640). Custom methods
  // do not receive the SDK's cache hints, so the fields are set on the result directly.
  const cache = { ttlMs: cacheTtlMs, cacheScope: 'private' as const }
  server.setRequestHandler('skills/list', { params: fromJsonSchema({ type: 'object', properties: { cursor: { type: 'string' } } }) }, async () => ({
    skills: skills.map(skillEntry), ...cache
  }))
  server.setRequestHandler('skills/get', { params: fromJsonSchema<{ uri: string }>({ type: 'object', required: ['uri'], properties: { uri: { type: 'string' } } }) }, async (params) => {
    const s = byUri.get(params.uri)
    if (!s) throw new ProtocolError(INVALID_PARAMS, `No skill is served at ${params.uri}`)
    return { skill: skillEntry(s), ...cache }
  })
}
