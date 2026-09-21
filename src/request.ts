import type { ResolvedOperation } from './types.ts'
import type { Binding } from './input.ts'

const joinIfArray = (v: unknown) => Array.isArray(v) ? v.join(',') : String(v)

function appendQuery (search: URLSearchParams, name: string, value: unknown, explode: boolean | undefined) {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    if (explode === false) search.append(name, value.join(','))
    else for (const v of value) search.append(name, String(v))
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== undefined && v !== null) search.append(k, joinIfArray(v))
  } else {
    search.append(name, String(value))
  }
}

export function buildRequest (op: ResolvedOperation, bindings: Binding[], params: Record<string, unknown>, baseUrl: string): Request {
  let path = op.path
  const search = new URLSearchParams()
  const headers = new Headers({ accept: op.responseMediaTypes.includes('text/markdown') ? 'text/markdown' : 'application/json' })
  const fixed: Record<string, unknown> = { ...(op.agent.fixed ?? {}) }
  let bodyProps: Record<string, unknown> | undefined
  let body: unknown

  for (const b of bindings) {
    const value = params[b.toolName]
    switch (b.kind) {
      case 'path': {
        if (value === undefined || value === null) throw new Error(`missing path parameter "${b.toolName}"`)
        path = path.replace(`{${b.apiName}}`, encodeURIComponent(joinIfArray(value)))
        break
      }
      case 'query': appendQuery(search, b.apiName, value, b.explode); break
      case 'header': if (value !== undefined && value !== null) headers.set(b.apiName, String(value)); break
      case 'fields': {
        if (Array.isArray(value) && value.length) {
          delete fixed[b.apiName]
          appendQuery(search, b.apiName, value, b.explode)
        }
        break
      }
      case 'responseFormat': break
      case 'bodyProp': if (value !== undefined) (bodyProps ??= {})[b.apiName] = value; break
      case 'body': body = value; break
    }
  }
  for (const [k, v] of Object.entries(fixed)) search.append(k, joinIfArray(v))

  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : baseUrl + '/')
  url.search = search.toString()
  const init: RequestInit = { method: op.method, headers }
  const payload = body ?? bodyProps
  if (payload !== undefined) {
    headers.set('content-type', 'application/json')
    init.body = JSON.stringify(payload)
  }
  return new Request(url, init)
}
