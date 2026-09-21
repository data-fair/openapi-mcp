import { createHash } from 'node:crypto'
import { localize } from '../localize.ts'
import { prepareSchema } from './prepare-schema.ts'
import { editorRequest, type EditorOperations } from './operations.ts'
import type { AgentEditor, JsonSchema } from '../types.ts'

export interface EditorContext {
  doc: JsonSchema
  baseUrl: string
  fetch: typeof globalThis.fetch
  locale: string
}

export interface SchemaRegistry {
  get (ops: EditorOperations, pathParams: Record<string, unknown>, ctx: EditorContext): () => Promise<unknown>
}

const editorOf = (ops: EditorOperations): AgentEditor => ops.write.agent.editor === true ? {} : (ops.write.agent.editor ?? {})

async function json (ctx: EditorContext, request: Request): Promise<{ text: string, value: unknown }> {
  const response = await ctx.fetch(request)
  const text = await response.text()
  if (!response.ok) throw new Error(`${request.method} ${request.url} failed: ${response.status} ${text.slice(0, 200)}`)
  return { text, value: text ? JSON.parse(text) : undefined }
}

/**
 * One schema closure per distinct schema, shared by every session that needs it.
 *
 * `resolveCompiledLayout` caches compiled layouts against the schema *function object*,
 * so a fresh closure per session means a fresh compilation per session. Keyed by what the
 * schema request actually depends on — the operation, its own path parameters, and the
 * fixed query — which for dataset lines is the dataset, not the line.
 */
export function createSchemaRegistry (): SchemaRegistry {
  const closures = new Map<string, () => Promise<unknown>>()
  return {
    get (ops, pathParams, ctx) {
      const editor = editorOf(ops)
      if (!ops.schema) {
        // No schemaOperation: the declared request body is the schema, constant for the
        // life of the process, so one closure for the operation is the same rule.
        const key = `declared:${ops.write.operationId}`
        let closure = closures.get(key)
        if (!closure) {
          const declared = ops.write.requestBody!.schema
          closure = async () => ({ schema: await prepareSchema(declared), version: ops.write.operationId })
          closures.set(key, closure)
        }
        return closure
      }
      const own: Record<string, unknown> = {}
      for (const p of ops.schema.params) if (p.in === 'path') own[p.name] = pathParams[p.name]
      const key = `${ops.schema.operationId}:${JSON.stringify(own)}:${JSON.stringify(editor.schemaParams ?? {})}`
      let closure = closures.get(key)
      if (!closure) {
        closure = async () => {
          const request = editorRequest(ops.schema!, own, editor.schemaParams ?? {}, undefined, ctx.baseUrl)
          const { text, value } = await json(ctx, request)
          // The body's hash, because the response carries no validator header and the
          // dataset's updatedAt is a second request away. It only has to change when the
          // schema does.
          return { schema: await prepareSchema(value as JsonSchema), version: createHash('sha1').update(text).digest('hex') }
        }
        closures.set(key, closure)
      }
      return closure
    }
  }
}

export function buildSessionSpec (ops: EditorOperations, pathParams: Record<string, unknown>, ctx: EditorContext, registry: SchemaRegistry): object {
  const read = ops.read
  return {
    title: localize(ops.write.agent.title, ctx.locale) ?? ops.write.operationId,
    prefixName: `${ops.write.toolName}_`,
    schema: registry.get(ops, pathParams, ctx),
    load: async () => {
      if (!read) return { data: {}, version: undefined }
      const own: Record<string, unknown> = {}
      for (const p of read.params) if (p.in === 'path') own[p.name] = pathParams[p.name]
      const { value } = await json(ctx, editorRequest(read, own, {}, undefined, ctx.baseUrl))
      return { data: value, version: undefined }
    },
    // `context.base` goes unused: both target operations replace the whole document, so
    // there is nothing to diff against.
    save: async (data: unknown) => {
      const own: Record<string, unknown> = {}
      for (const p of ops.write.params) if (p.in === 'path') own[p.name] = pathParams[p.name]
      await json(ctx, editorRequest(ops.write, own, {}, data, ctx.baseUrl))
      return { version: undefined }
    },
    options: { fetch: ctx.fetch, fetchBaseURL: ctx.baseUrl }
  }
}
