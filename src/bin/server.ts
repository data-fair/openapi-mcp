#!/usr/bin/env node
import { createServer } from 'node:http'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { load } from '../load.ts'
import { createMcpServer } from '../adapters/mcp.ts'

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
const info = { name: 'openapi-mcp', version: '0.1.0' }

if ((env.TRANSPORT ?? 'stdio') === 'http') {
  const port = Number(env.PORT ?? 8080)
  const http = createServer(async (req, res) => {
    // stateless: one server + transport per request, no session ids
    const server = createMcpServer(toolSet, info)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close().catch((err: unknown) => console.error('error closing transport:', err))
      server.close().catch((err: unknown) => console.error('error closing server:', err))
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res)
    } catch (err) {
      console.error('error handling MCP request:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        }))
      }
    }
  })
  http.listen(port, () => console.error(`openapi-mcp listening on http://0.0.0.0:${port} (${toolSet.tools.length} tools, profiles ${toolSet.profiles.join(',')})`))
} else {
  const server = createMcpServer(toolSet, info)
  await server.connect(new StdioServerTransport())
  console.error(`openapi-mcp ready on stdio (${toolSet.tools.length} tools, profiles ${toolSet.profiles.join(',')})`)
}
