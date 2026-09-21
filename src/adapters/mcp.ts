import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolSet } from '../types.ts'

export function toMcpServer (toolSet: ToolSet, server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolSet.tools.find(t => t.name === req.params.name)
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] }
    const result = await tool.execute(req.params.arguments ?? {})
    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result.isError ? { isError: true } : {})
    }
  })
}

export function createMcpServer (toolSet: ToolSet, info: { name: string, version: string }): Server {
  const server = new Server(info, { capabilities: { tools: {} }, instructions: toolSet.instructions || undefined })
  toMcpServer(toolSet, server)
  return server
}
