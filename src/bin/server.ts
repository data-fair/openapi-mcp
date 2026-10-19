#!/usr/bin/env node
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import type { Server } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { load } from '../load.ts'
import { createLiveDocument, type LiveDocument } from '../live.ts'
import { createMcpHttpHandler, mcpServerFactory, resolveToolSet, type ToolSource } from '../adapters/mcp.ts'

const env = process.env
// Removed in 0.7.0: refused rather than ignored, so an old configuration does not serve another surface.
const removed = ['INDEX_URL', 'PROFILES', 'PROFILE'].filter(name => env[name] !== undefined)
if (removed.length) {
  console.error(`unknown variable${removed.length > 1 ? 's' : ''} ${removed.join(', ')}: openapi-mcp serves one document, set OPENAPI_URL`)
  process.exit(1)
}
const openapiUrl = env.OPENAPI_URL
if (!openapiUrl) {
  console.error('OPENAPI_URL is required')
  process.exit(1)
}

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

/** A positive number from the environment, or undefined when unset; anything else stops the binary. */
const positiveEnv = (name: string): number | undefined => {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`${name} must be a positive number, got "${raw}"`)
    process.exit(1)
  }
  return n
}
const fileTimeout = positiveEnv('FILE_TIMEOUT')

const options = {
  locale: env.LOCALE ?? 'en',
  baseUrl: env.BASE_URL,
  structuredContent: env.STRUCTURED_CONTENT === 'true',
  lint,
  fetch: fetchFn,
  files: {
    urlPrefixes: env.FILE_URL_PREFIXES?.split(',').map(s => s.trim()).filter(Boolean),
    maxSize: positiveEnv('FILE_MAX_SIZE'),
    timeout: fileTimeout === undefined ? undefined : fileTimeout * 1000
  }
}

// The library never runs a timer; this binary does, when it refreshes at all.
let live: LiveDocument | undefined
let source: ToolSource
if (refreshMs > 0) {
  const doc = live = await createLiveDocument(openapiUrl, options)
  setInterval(() => {
    doc.refresh().then(() => { if (doc.error) console.error(`refresh failed: ${doc.error}`) }, (err: unknown) => console.error('refresh failed:', err))
  }, refreshMs).unref()
  source = doc
} else {
  source = await load(openapiUrl, options)
}
// A broken skill link does not stop the server: the skill answers its error when read.
for (const s of (await resolveToolSet(source)).skills) if (s.error) console.error(`skill ${s.name}: warning — ${s.error}`)
// package.json sits two levels up from both src/bin and dist/bin, and ships with the package.
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const info = { name: 'openapi-mcp', version }
const describe = async () => {
  const ts = await resolveToolSet(source)
  return `${ts.tools.length} tools, ${ts.skills.length} skills`
}

if ((env.TRANSPORT ?? 'stdio') === 'http') {
  const port = Number(env.PORT ?? 8080)
  const handler = createMcpHttpHandler(source, info, { refreshMs: refreshMs || undefined })
  createServer(toNodeHandler(handler)).listen(port, async () => console.error(`openapi-mcp listening on http://0.0.0.0:${port} (${await describe()})`))
} else {
  // One stdio connection is one caller; the era-pinned instance the factory returns is
  // the one to notify when a refresh changes the set.
  let pinned: Server | undefined
  const factory = mcpServerFactory(source, info, { refreshMs: refreshMs || undefined })
  serveStdio(async (ctx) => { pinned = await factory(ctx) as Server; return pinned })
  live?.onChange(() => pinned?.sendToolListChanged().catch(() => {}))
  console.error(`openapi-mcp ready on stdio (${await describe()})`)
}
