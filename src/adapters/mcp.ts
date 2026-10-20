import { Server, createMcpHandler, type McpServerFactory, type McpHttpHandler, type CreateMcpHandlerOptions } from '@modelcontextprotocol/server'
import { clientDeclaresSkills, serverOptions, toMcpServer, DEFAULT_CACHE_TTL_MS } from './server.ts'
import type { CallContext, ToolSet } from '../types.ts'

/** Chooses the tool set per request; stdio and the version-negotiation probe pass `undefined`. */
export type ToolSourceFn = (request: Request | undefined) => ToolSet | Promise<ToolSet>

export interface McpAdapterOptions {
  /** derive the per-call context from the HTTP request; absent on stdio, where identity is the environment */
  context?: (request: Request | undefined) => CallContext | undefined
  /** how long a client may keep a listing, advertised as `ttlMs` on cacheable results (default 5 minutes) */
  cacheTtlMs?: number
}

const isSourceFn = (s: ToolSet | ToolSourceFn): s is ToolSourceFn => typeof s === 'function'

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
