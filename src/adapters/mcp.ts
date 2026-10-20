import {
  Server, createMcpHandler, fromJsonSchema, ProtocolError, INVALID_PARAMS, INTERNAL_ERROR,
  type ServerOptions, type McpServerFactory, type McpHttpHandler, type CreateMcpHandlerOptions, type CacheHint
} from '@modelcontextprotocol/server'
import { renderSkillFile, skillUri, type SkillFile } from '../skills.ts'
import type { CallContext, ToolSet } from '../types.ts'

/** Chooses the tool set per request; stdio and the version-negotiation probe pass `undefined`. */
export type ToolSourceFn = (request: Request | undefined) => ToolSet | Promise<ToolSet>

export interface McpAdapterOptions {
  /** derive the per-call context from the HTTP request; absent on stdio, where identity is the environment */
  context?: (request: Request | undefined) => CallContext | undefined
  /** how long a client may keep a listing, advertised as `ttlMs` on cacheable results: how often the tool set can change */
  cacheTtlMs?: number
}

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
const DEFAULT_CACHE_TTL_MS = 300_000

const isSourceFn = (s: ToolSet | ToolSourceFn): s is ToolSourceFn => typeof s === 'function'

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

export function serverOptions (toolSet: ToolSet, cacheTtlMs: number, opts: { skillsAware?: boolean } = {}): ServerOptions {
  const hint: CacheHint = { ttlMs: cacheTtlMs, cacheScope: 'private' }
  const instructions = opts.skillsAware ? toolSet.guideInstructions : toolSet.instructions
  return {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, extensions: { [SKILLS_EXTENSION]: {} } },
    instructions: instructions || undefined,
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
    if (broken) throw new ProtocolError(INTERNAL_ERROR, `The skill ${broken.id} could not be read: ${broken.error}`)
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

/** One server for one caller: the request's tool set and context, or the options' defaults. */
export async function createMcpServer (source: ToolSet | ToolSourceFn, info: { name: string, version: string }, options: McpAdapterOptions & { request?: Request } = {}): Promise<Server> {
  const toolSet = isSourceFn(source) ? await source(options.request) : source
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const server = new Server(info, serverOptions(toolSet, cacheTtlMs, { skillsAware: await clientDeclaresSkills(options.request) }))
  toMcpServer(toolSet, server, { ctx: options.context?.(options.request), cacheTtlMs })
  return server
}

/** The per-request factory both SDK entries (`createMcpHandler`, `serveStdio`) take. */
export function mcpServerFactory (source: ToolSet | ToolSourceFn, info: { name: string, version: string }, options: McpAdapterOptions = {}): McpServerFactory {
  return (ctx) => createMcpServer(source, info, { ...options, request: ctx.requestInfo })
}

/**
 * An HTTP handler serving both protocol eras. Whoever changes the tool set a function source returns
 * tells the connected clients with `handler.notify.toolsChanged()` and `resourcesChanged()`.
 */
export function createMcpHttpHandler (source: ToolSet | ToolSourceFn, info: { name: string, version: string }, options: McpAdapterOptions & CreateMcpHandlerOptions = {}): McpHttpHandler {
  const { context, cacheTtlMs, ...handlerOptions } = options
  return createMcpHandler(mcpServerFactory(source, info, { context, cacheTtlMs }), handlerOptions)
}
