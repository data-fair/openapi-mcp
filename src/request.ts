import type { ResolvedOperation } from './types.ts'
import type { Binding } from './input.ts'
import { encodeMultipart, encodeRaw, partValue, type EncodedBody, type FileSource, type Part } from './multipart.ts'

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

const essence = (t: string) => t.split(';')[0].trim().toLowerCase()

/** A raw file body's Content-Type: the source's when the operation declares it, else the first declared. */
export function rawContentType (declared: string[], source: string | undefined): string {
  const s = source ? essence(source) : undefined
  return declared.find(t => essence(t) === s) ?? declared[0]
}

/** `files`: the opened sources of the file inputs, by input name (see openFiles). */
export function buildRequest (op: ResolvedOperation, bindings: Binding[], params: Record<string, unknown>, baseUrl: string, files: Record<string, FileSource> = {}): Request {
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
      case 'file': break
      case 'bodyProp': if (value !== undefined) (bodyProps ??= {})[b.apiName] = value; break
      case 'body': body = value; break
    }
  }
  for (const [k, v] of Object.entries(fixed)) search.append(k, joinIfArray(v))

  const url = new URL(path.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : baseUrl + '/')
  url.search = search.toString()
  const init: RequestInit & { duplex?: 'half' } = { method: op.method, headers }
  // A streamed body with its exact length: servers that check a size before accepting an
  // upload (data-fair answers 411) refuse Transfer-Encoding: chunked.
  const send = (encoded: EncodedBody) => {
    headers.set('content-type', encoded.contentType)
    headers.set('content-length', String(encoded.length))
    init.body = encoded.body
    init.duplex = 'half'
  }
  const kind = op.requestBody?.kind
  if (kind === 'multipart') {
    const parts: Part[] = []
    for (const [name, value] of Object.entries(bodyProps ?? {})) {
      const text = partValue(value)
      if (text !== undefined) parts.push({ name, value: text })
    }
    for (const b of bindings) {
      const file = b.kind === 'file' ? files[b.toolName] : undefined
      if (file) parts.push({ name: b.apiName, file, contentType: file.contentType ?? b.accept?.[0] ?? 'application/octet-stream' })
    }
    if (parts.length) send(encodeMultipart(parts))
  } else if (kind === 'file') {
    const binding = bindings.find(b => b.kind === 'file')
    const file = binding ? files[binding.toolName] : undefined
    if (file) send(encodeRaw(file, rawContentType(op.requestBody!.mediaTypes!, file.contentType)))
  } else {
    const payload = body ?? bodyProps
    if (payload !== undefined) {
      headers.set('content-type', 'application/json')
      init.body = JSON.stringify(payload)
    }
  }
  return new Request(url, init)
}
