import {
  Server, createMcpHandler, fromJsonSchema, ProtocolError, INVALID_PARAMS,
  type ServerOptions, type McpServerFactory, type McpHttpHandler, type CreateMcpHandlerOptions, type CacheHint
} from '@modelcontextprotocol/server'
import { renderSkillFile, type SkillFile } from '../skills.ts'
import type { Composer, Composition } from '../compose.ts'
import type { CallContext, ToolSet } from '../types.ts'

export type ToolSource = ToolSet | Composition | Composer
/** Chooses the source per request; stdio and the version-negotiation probe pass `undefined`. */
export type ToolSourceFn = (request: Request | undefined) => ToolSource | Promise<ToolSource>

export interface McpAdapterOptions {
  /** derive the per-call context from the HTTP request; absent on stdio, where identity is the environment */
  context?: (request: Request | undefined) => CallContext | undefined
  /** the profile set when the request carries none (`?profiles=` absent, or stdio) */
  profiles?: string[]
  /** how often the caller refreshes the composition; advertised as `ttlMs` on cacheable results */
  refreshMs?: number
}

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
const DEFAULT_REFRESH_MS = 300_000

const isComposer = (s: ToolSource): s is Composer => typeof (s as Composer).compose === 'function'
const isComposition = (s: ToolSource): s is Composition => !isComposer(s) && typeof (s as Composition).onChange === 'function'
const isSourceFn = (s: ToolSource | ToolSourceFn): s is ToolSourceFn => typeof s === 'function'

/** The `profiles` query parameter as a set, or undefined when absent. */
export function requestProfiles (request: Request | undefined): string[] | undefined {
  const raw = request ? new URL(request.url).searchParams.get('profiles') : null
  if (!raw) return undefined
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

export async function resolveToolSet (source: ToolSource, profiles?: string[]): Promise<ToolSet> {
  if (isComposer(source)) {
    // A typo must not silently serve an empty set: a name nothing declares is a request error.
    const known = new Set(source.profiles().map(p => p.name))
    const unknown = (profiles ?? []).filter(p => !known.has(p))
    if (unknown.length) throw new Error(`unknown profile "${unknown[0]}" (declared: ${[...known].join(', ')})`)
    return (await source.compose(profiles)).toolSet
  }
  if (isComposition(source)) return source.toolSet
  return source
}

export function serverOptions (toolSet: ToolSet, refreshMs: number): ServerOptions {
  const hint: CacheHint = { ttlMs: refreshMs, cacheScope: 'private' }
  return {
    capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, extensions: { [SKILLS_EXTENSION]: {} } },
    instructions: toolSet.instructions || undefined,
    cacheHints: { 'tools/list': hint, 'resources/list': hint, 'resources/read': hint, 'server/discover': hint }
  }
}

const skillEntry = (s: SkillFile) => ({ uri: s.uri, frontmatter: s.frontmatter, resources: [{ uri: s.uri, digest: s.digest, size: s.size }] })

/** Register tools, resources and the skills extension on a low-level server, for one caller. */
export function toMcpServer (toolSet: ToolSet, server: Server, options: { ctx?: CallContext, refreshMs?: number } = {}): void {
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS
  const skills = toolSet.skills.map(renderSkillFile)
  const byUri = new Map(skills.map(s => [s.uri, s]))

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
    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result.isError ? { isError: true } : {})
    }
  })
  server.setRequestHandler('resources/list', async () => ({
    resources: skills.map(s => ({ uri: s.uri, name: s.frontmatter.name, description: s.frontmatter.description, mimeType: 'text/markdown' }))
  }))
  server.setRequestHandler('resources/read', async (req) => {
    const s = byUri.get(req.params.uri)
    if (!s) throw new ProtocolError(INVALID_PARAMS, `No resource is served at ${req.params.uri}`)
    return { contents: [{ uri: s.uri, mimeType: 'text/markdown', text: s.text }] }
  })
  // The extension's two methods, on the base Resources primitive (SEP-2640). Custom methods
  // do not receive the SDK's cache hints, so the fields are set on the result directly.
  const cache = { ttlMs: refreshMs, cacheScope: 'private' as const }
  server.setRequestHandler('skills/list', { params: fromJsonSchema({ type: 'object', properties: { cursor: { type: 'string' } } }) }, async () => ({
    skills: skills.map(skillEntry), ...cache
  }))
  server.setRequestHandler('skills/get', { params: fromJsonSchema<{ uri: string }>({ type: 'object', required: ['uri'], properties: { uri: { type: 'string' } } }) }, async (params) => {
    const s = byUri.get(params.uri)
    if (!s) throw new ProtocolError(INVALID_PARAMS, `No skill is served at ${params.uri}`)
    return { skill: skillEntry(s), ...cache }
  })
}

/** One server for one caller: the request's profile set and context, or the options' defaults. */
export async function createMcpServer (source: ToolSource | ToolSourceFn, info: { name: string, version: string }, options: McpAdapterOptions & { request?: Request } = {}): Promise<Server> {
  const resolved = isSourceFn(source) ? await source(options.request) : source
  const toolSet = await resolveToolSet(resolved, requestProfiles(options.request) ?? options.profiles)
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS
  const server = new Server(info, serverOptions(toolSet, refreshMs))
  toMcpServer(toolSet, server, { ctx: options.context?.(options.request), refreshMs })
  return server
}

/** The per-request factory both SDK entries (`createMcpHandler`, `serveStdio`) take. */
export function mcpServerFactory (source: ToolSource | ToolSourceFn, info: { name: string, version: string }, options: McpAdapterOptions = {}): McpServerFactory {
  return (ctx) => createMcpServer(source, info, { ...options, request: ctx.requestInfo })
}

/** An HTTP handler serving both protocol eras, publishing change notifications from a live source. */
export function createMcpHttpHandler (source: ToolSource | ToolSourceFn, info: { name: string, version: string }, options: McpAdapterOptions & CreateMcpHandlerOptions = {}): McpHttpHandler {
  const { context, profiles, refreshMs, ...handlerOptions } = options
  const handler = createMcpHandler(mcpServerFactory(source, info, { context, profiles, refreshMs }), handlerOptions)
  // A function source decides per request; whoever owns it publishes changes through handler.notify.
  if (!isSourceFn(source) && (isComposer(source) || isComposition(source))) {
    source.onChange(() => { handler.notify.toolsChanged(); handler.notify.resourcesChanged() })
  }
  return handler
}
