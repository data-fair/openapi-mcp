#!/usr/bin/env node
import { createServer } from 'node:http'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import type { Server } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { load } from '../load.ts'
import { createComposer, type Composer } from '../compose.ts'
import { createMcpHttpHandler, mcpServerFactory, resolveToolSet, type ToolSource } from '../adapters/mcp.ts'

const env = process.env
const indexUrl = env.INDEX_URL
const openapiUrl = env.OPENAPI_URL
if (!indexUrl === !openapiUrl) {
  console.error('exactly one of INDEX_URL or OPENAPI_URL is required')
  process.exit(1)
}

const profiles = (env.PROFILES ?? env.PROFILE)?.split(',').map(s => s.trim()).filter(Boolean)
const refreshMs = Number(env.REFRESH_INTERVAL ?? 300) * 1000
const lint = (env.LINT ?? 'error') as 'error' | 'warn' | 'off'

// The single-credential convenience: a fixed header on every upstream request. Anything
// richer lives outside this binary — nhi-proxy through the environment, or a server's
// context hook.
const apiKeyHeader = env.API_KEY_HEADER
const apiKey = env.API_KEY
const fetchFn: typeof fetch = (input, init) => {
  const req = new Request(input, init)
  if (apiKeyHeader && apiKey) req.headers.set(apiKeyHeader, apiKey)
  return fetch(req)
}

const options = {
  locale: env.LOCALE ?? 'en',
  baseUrl: env.BASE_URL,
  structuredContent: env.STRUCTURED_CONTENT === 'true',
  lint,
  fetch: fetchFn
}

let source: ToolSource
let composer: Composer | undefined
if (indexUrl) {
  composer = await createComposer(indexUrl, options)
  for (const s of composer.services) if (s.status !== 'ok') console.error(`service ${s.id}: ${s.status}${s.reason ? ` — ${s.reason}` : ''}`)
  source = composer
} else {
  source = await load(openapiUrl!, { ...options, profiles })
}
const info = { name: 'openapi-mcp', version: '0.2.0' }
const describe = async () => {
  const ts = await resolveToolSet(source, profiles)
  return `${ts.tools.length} tools, ${ts.skills.length} skills, profiles ${ts.profiles.join(',')}`
}

// The library never runs a timer; this binary does, and only over an index.
if (composer && refreshMs > 0) {
  const live = composer
  setInterval(() => live.refresh().catch((err: unknown) => console.error('refresh failed:', err)), refreshMs).unref()
}

if ((env.TRANSPORT ?? 'stdio') === 'http') {
  const port = Number(env.PORT ?? 8080)
  const handler = createMcpHttpHandler(source, info, { profiles, refreshMs: refreshMs || undefined })
  createServer(toNodeHandler(handler)).listen(port, async () => console.error(`openapi-mcp listening on http://0.0.0.0:${port} (${await describe()})`))
} else {
  // One stdio connection is one caller; the era-pinned instance the factory returns is
  // the one to notify when a refresh changes the set.
  let pinned: Server | undefined
  const factory = mcpServerFactory(source, info, { profiles, refreshMs: refreshMs || undefined })
  serveStdio(async (ctx) => { pinned = await factory(ctx) as Server; return pinned })
  composer?.onChange(() => pinned?.sendToolListChanged().catch(() => {}))
  console.error(`openapi-mcp ready on stdio (${await describe()})`)
}
