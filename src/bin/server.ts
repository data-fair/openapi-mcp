#!/usr/bin/env node
import { createServer } from 'node:http'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { load } from '../load.ts'
import { createMcpHttpHandler, mcpServerFactory } from '../adapters/mcp.ts'

const env = process.env
const openapiUrl = env.OPENAPI_URL
if (!openapiUrl) {
  console.error('OPENAPI_URL is required')
  process.exit(1)
}

const apiKeyHeader = env.API_KEY_HEADER
const apiKey = env.API_KEY
const fetchFn: typeof fetch = (input, init) => {
  const req = new Request(input, init)
  if (apiKeyHeader && apiKey) req.headers.set(apiKeyHeader, apiKey)
  return fetch(req)
}

const toolSet = await load(openapiUrl, {
  profile: env.PROFILE,
  locale: env.LOCALE ?? 'en',
  baseUrl: env.BASE_URL,
  structuredContent: env.STRUCTURED_CONTENT === 'true',
  fetch: fetchFn
})
const info = { name: 'openapi-mcp', version: '0.2.0' }

if ((env.TRANSPORT ?? 'stdio') === 'http') {
  const port = Number(env.PORT ?? 8080)
  const handler = createMcpHttpHandler(toolSet, info)
  createServer(toNodeHandler(handler)).listen(port, () => console.error(`openapi-mcp listening on http://0.0.0.0:${port} (${toolSet.tools.length} tools, profiles ${toolSet.profiles.join(',')})`))
} else {
  serveStdio(mcpServerFactory(toolSet, info))
  console.error(`openapi-mcp ready on stdio (${toolSet.tools.length} tools, profiles ${toolSet.profiles.join(',')})`)
}
