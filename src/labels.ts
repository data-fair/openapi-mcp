/**
 * Checked labels (docs/x-agent.md#checked-labels): a write naming a resource by an opaque id also
 * carries that resource's label, which the tool checks against the API before the call, refusing it
 * on a mismatch. The id keeps the match exact; the label makes the call say what it acts on, to
 * whoever reads only its arguments (a person approving it, an automatic reviewer). The label input
 * is marked `x-checked` in the input schema, so such a reader can tell a checked label from text
 * the model wrote.
 *
 * It refuses a call, it never changes one: what reaches the API is the same call without the
 * label. The read and the write are two requests, so a rename in between is not caught: the check
 * is about clarity, not concurrency.
 */
import { resolveOperationById } from './spec.ts'
import { editorRequest } from './editor/operations.ts'
import { callFetch } from './context.ts'
import { pointerKeys, schemaAt } from './input.ts'
import { localize } from './localize.ts'
import type { AgentLabel, CallContext, JsonSchema, ResolvedOperation } from './types.ts'

export interface ResolvedLabel {
  /** the tool input holding the id (or the ids) */
  target: string
  /** the tool input holding the label (or the labels) */
  name: string
  field: string
  read: ResolvedOperation
  /** the read operation's path parameter, given the id */
  idParam: string
  description?: AgentLabel['description']
}

/** The marker on a label input: what it is checked against. */
export interface CheckedMarker { against: string, field: string }

/** An operation's labels with their read operations, checked against the document. */
export function resolveLabels (op: ResolvedOperation, doc: JsonSchema): ResolvedLabel[] {
  return Object.entries(op.agent.labels ?? {}).map(([target, label]) => {
    const at = `${op.toolName}: labels.${target}`
    const read = resolveOperationById(doc, label.operation)
    if (!read) throw new Error(`${at} names "${label.operation}", which is not an operation in this document`)
    if (read.method !== 'GET') throw new Error(`${at} names "${label.operation}", a ${read.method}: a label is read with a GET`)
    const pathParams = read.params.filter(p => p.in === 'path')
    if (pathParams.length !== 1) throw new Error(`${at} names "${label.operation}", which needs ${pathParams.length} path parameters: a label's read takes one, the id`)
    const fixed = read.agent.fixed ?? {}
    const unmet = read.params.filter(p => p.in !== 'path' && p.required && !(p.name in fixed)).map(p => p.name)
    if (unmet.length) throw new Error(`${at} names "${label.operation}", which also requires ${unmet.join(', ')}: a label's read takes the id alone`)
    // Checked when the response declares the field's place; an undeclared response is read as it comes.
    const node = schemaAt(read.responseSchema, label.field)
    if (read.responseSchema?.properties && !node) throw new Error(`${at}: field "${label.field}" is not in the response schema of "${label.operation}"`)
    if (node?.type !== undefined && node.type !== 'string') throw new Error(`${at}: field "${label.field}" of "${label.operation}" is not a string`)
    return { target, name: label.name, field: label.field, read, idParam: pathParams[0].name, ...(label.description ? { description: label.description } : {}) }
  })
}

const lastKey = (pointer: string) => pointerKeys(pointer).at(-1) ?? 'label'

/**
 * Adds each label's input to a built input schema, beside its target: a string, or a list of strings
 * for a list of ids. Required with its target, or whenever the target is given. Returns the names
 * whose description this project wrote, for the description lint.
 */
export function addLabelInputs (inputSchema: JsonSchema, labels: ResolvedLabel[], locale: string, toolName: string): string[] {
  const properties: JsonSchema = inputSchema.properties
  const authored: string[] = []
  for (const label of labels) {
    const target = properties[label.target]
    if (!target) throw new Error(`labels.${label.target} checks an input the tool does not have (inputs: ${Object.keys(properties).join(', ')})`)
    if (Object.hasOwn(properties, label.name)) throw new Error(`labels.${label.target}: "${label.name}" is already an input of ${toolName}`)
    const many = target.type === 'array'
    if (!many && target.type !== undefined && target.type !== 'string') throw new Error(`labels.${label.target} checks an input that is not an id (a string or a list of strings)`)
    const key = lastKey(label.field)
    const description = localize(label.description, locale) ?? (many
      ? `The ${key} of each item of \`${label.target}\`, in the same order, as the API gives it. Checked before the call: it is refused, and nothing sent, unless each is the ${key} of the item at its position. It shows whoever reads the call which items it acts on.`
      : `The ${key} of what \`${label.target}\` names, as the API gives it. Checked before the call: it is refused, and nothing sent, unless it is that ${key}. It shows whoever reads the call what it acts on.`)
    const marker: CheckedMarker = { against: label.target, field: label.field }
    properties[label.name] = many
      ? { type: 'array', items: { type: 'string' }, description, 'x-checked': marker }
      : { type: 'string', description, 'x-checked': marker }
    authored.push(label.name)
    if (inputSchema.required?.includes(label.target)) inputSchema.required.push(label.name)
    else (inputSchema.dependentRequired ??= {})[label.target] = [label.name]
  }
  return authored
}

const normalize = (text: string) => text.normalize('NFC').trim().replace(/\s+/g, ' ')

const valueAt = (body: unknown, pointer: string): unknown =>
  pointerKeys(pointer).reduce<unknown>((node, key) => node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined, body)

/**
 * Checks every label of a call: undefined when each one is the label of what its id names, else the
 * refusal's text. A call that gives no id has no label to check (the schema requires one with it).
 */
export async function checkLabels (labels: ResolvedLabel[], params: Record<string, unknown>, ctx: CallContext | undefined, fetchFn: typeof fetch, baseUrl: string): Promise<string | undefined> {
  for (const label of labels) {
    const ids = params[label.target]
    if (ids === undefined || ids === null) continue
    const given = params[label.name]
    const many = Array.isArray(ids)
    const idList = (many ? ids : [ids]).map(String)
    const labelList = Array.isArray(given) ? given : [given]
    if (many !== Array.isArray(given) || idList.length !== labelList.length) {
      return `"${label.name}" must give one ${lastKey(label.field)} per item of "${label.target}" (${idList.length}), in the same order; nothing was sent.`
    }
    const found = await Promise.all(idList.map(async id => {
      const res = await callFetch(editorRequest(label.read, { [label.idParam]: id }, {}, undefined, baseUrl), ctx, fetchFn)
      if (!res.ok) return { id, error: `HTTP ${res.status}` }
      let body: unknown
      try { body = await res.json() } catch { return { id, error: 'not JSON' } }
      const value = valueAt(body, label.field)
      return typeof value === 'string' ? { id, value } : { id, error: `no ${lastKey(label.field)} in it` }
    }))
    for (const [i, result] of found.entries()) {
      const where = many ? `"${label.target}" item ${i} (${result.id})` : `"${label.target}" (${result.id})`
      if ('error' in result) return `Could not read the ${lastKey(label.field)} of ${where} to check "${label.name}" (${result.error}); nothing was sent.`
      const expected = labelList[i]
      if (typeof expected !== 'string' || normalize(expected) !== normalize(result.value!)) {
        return `${where} is ${JSON.stringify(result.value)}, not ${JSON.stringify(expected)}; nothing was sent. Check that the id is the one you meant, and give its ${lastKey(label.field)} as the API returns it.`
      }
    }
  }
  return undefined
}
