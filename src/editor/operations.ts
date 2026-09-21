import { resolveOperationById } from '../spec.ts'
import { buildRequest } from '../request.ts'
import type { Binding } from '../input.ts'
import type { AgentEditor, JsonSchema, ResolvedOperation } from '../types.ts'

export interface EditorOperations {
  write: ResolvedOperation
  schema?: ResolvedOperation
  read?: ResolvedOperation
  /** the write operation's path parameter names, in declared order */
  pathParamNames: string[]
}

function named (doc: JsonSchema, operationId: string | undefined, write: ResolvedOperation, pathParamNames: string[], role: string): ResolvedOperation | undefined {
  if (!operationId) return undefined
  const op = resolveOperationById(doc, operationId)
  if (!op) throw new Error(`${write.operationId}: editor.${role} names "${operationId}", which is not an operation in this document`)
  // Path parameters are matched by name: a named operation can only ask for values the
  // write operation's own caller supplies. Caught here rather than on the first call,
  // because it is a defect in the document, not in the request.
  for (const p of op.params) {
    if (p.in === 'path' && !pathParamNames.includes(p.name)) {
      throw new Error(`${write.operationId}: editor.${role} "${operationId}" needs path parameter "${p.name}", which ${write.operationId} does not supply`)
    }
  }
  return op
}

export function resolveEditorOperations (write: ResolvedOperation, doc: JsonSchema): EditorOperations {
  if (!write.requestBody) throw new Error(`${write.operationId}: an editor needs a JSON request body`)
  const editor: AgentEditor = write.agent.editor === true ? {} : (write.agent.editor ?? {})
  const pathParamNames = write.params.filter(p => p.in === 'path').map(p => p.name)
  return {
    write,
    schema: named(doc, editor.schemaOperation, write, pathParamNames, 'schemaOperation'),
    read: named(doc, editor.readOperation, write, pathParamNames, 'readOperation'),
    pathParamNames
  }
}

/**
 * Build a request for one of the editor's own calls. These have no agent-facing input
 * schema, so the bindings are trivial: every parameter is addressed by its API name.
 */
export function editorRequest (op: ResolvedOperation, pathParams: Record<string, unknown>, query: Record<string, unknown>, body: unknown, baseUrl: string): Request {
  const bindings: Binding[] = op.params
    .filter(p => p.in !== 'header')
    .map(p => ({ toolName: p.name, kind: p.in as 'path' | 'query', apiName: p.name, style: p.style, explode: p.explode }))
  const params: Record<string, unknown> = { ...pathParams }
  for (const [k, v] of Object.entries(query)) {
    if (!bindings.some(b => b.toolName === k)) bindings.push({ toolName: k, kind: 'query', apiName: k })
    params[k] = v
  }
  if (body !== undefined) {
    bindings.push({ toolName: '__body', kind: 'body', apiName: '__body' })
    params.__body = body
  }
  return buildRequest(op, bindings, params, baseUrl)
}
