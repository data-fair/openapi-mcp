import { currentCall } from '../context.ts'
import type { CallContext, JsonSchema, ResolvedParam, Tool, ToolResult } from '../types.ts'

/** The shape @json-layout/agents hands us; typed here so this module need not import the optional peer. */
export interface FormTool {
  name: string
  description: string
  inputSchema?: JsonSchema
  execute (args?: Record<string, unknown>): Promise<{ content?: { type: string, text?: string }[], isError?: boolean }>
}

export function toToolResult (result: { content?: { type: string, text?: string }[], isError?: boolean }): ToolResult {
  const text = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')
  return { text, isError: result.isError }
}

/**
 * One package tool, addressed by resource.
 *
 * The package's tools have fixed input schemas and no notion of which record is being
 * edited, so the path parameters are added here and stripped back off before delegating.
 * `resolve` opens or resumes the session for those parameters.
 */
export function bridgeTool (descriptor: FormTool, pathParams: ResolvedParam[], resolve: (pathValues: Record<string, unknown>, ctx: CallContext | undefined) => Promise<FormTool>): Tool {
  const properties: Record<string, unknown> = {}
  for (const p of pathParams) properties[p.name] = p.schema
  for (const [k, v] of Object.entries(descriptor.inputSchema?.properties ?? {})) properties[k] = v

  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: {
      type: 'object',
      properties,
      required: [...pathParams.map(p => p.name), ...(descriptor.inputSchema?.required ?? [])]
    },
    annotations: { readOnlyHint: false },
    async execute (params: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult> {
      const pathValues: Record<string, unknown> = {}
      for (const p of pathParams) {
        const value = params?.[p.name]
        if (value === undefined || value === null) return { isError: true, text: `Missing required parameter "${p.name}".` }
        pathValues[p.name] = value
      }
      const rest = { ...params }
      for (const p of pathParams) delete rest[p.name]
      try {
        // The session's own requests (schema, load, save) happen inside this call and must
        // carry this call's headers — an NHI cookie rotates every two minutes, so nothing
        // captured when the session was opened may be reused.
        return await currentCall.run(ctx, async () => {
          const tool = await resolve(pathValues, ctx)
          return toToolResult(await tool.execute(rest))
        })
      } catch (err) {
        // A failed open — schema fetch, document load, a compile error — is a datum the
        // agent can act on, not a crash. Same contract as every other tool here.
        return { isError: true, text: `Error: ${err instanceof Error ? err.message : String(err)}` }
      }
    }
  }
}
