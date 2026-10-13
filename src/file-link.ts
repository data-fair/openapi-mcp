import { lookup, extension } from 'mime-types'
import { buildRequest } from './request.ts'
import type { Binding } from './input.ts'
import type { ResolvedOperation, ToolResult } from './types.ts'

const essence = (t: string) => t.split(';')[0].trim().toLowerCase()

/**
 * The link's media type: the success response's, when one is declared; among several, the one a
 * `format` query value names by extension (`fixed: { format: csv }` → text/csv); else none.
 */
export function linkMimeType (declared: string[], url: URL): string | undefined {
  const types = [...new Set(declared.map(essence))].filter(t => !t.includes('*'))
  if (types.length === 1) return types[0]
  const format = url.searchParams.get('format')
  const named = format ? lookup(format) : false
  return named && types.includes(named) ? named : undefined
}

/**
 * A name a file store can keep: the last path parameter's value and the segments after it
 * (`/datasets/{id}/lines` → `<id>-lines`), so two exports of different resources do not collide,
 * with an extension for its type when it has none — the extension is what types it if it is
 * uploaded again.
 */
export function linkName (pathTemplate: string, url: URL, mimeType: string | undefined): string {
  const template = pathTemplate.split('/').filter(Boolean)
  const actual = url.pathname.split('/').filter(Boolean).slice(-template.length).map(s => {
    try { return decodeURIComponent(s) } catch { return s }
  })
  const lastParam = template.findLastIndex(s => /^\{.+\}$/.test(s))
  const words = lastParam === -1 ? [actual.at(-1) ?? 'file'] : actual.slice(lastParam)
  let name = words.join('-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'file'
  const ext = mimeType && mimeType !== 'application/octet-stream' ? extension(mimeType) : false
  if (ext && !/\.[A-Za-z0-9]+$/.test(name)) name += `.${ext}`
  return name
}

/**
 * A `response.file` tool performs no request: it builds the URL a call would use and returns
 * it as a resource link, for the client to fetch with its own credentials. The text block is
 * for clients that ignore links.
 */
export function fileLink (op: ResolvedOperation, bindings: Binding[], params: Record<string, unknown>, baseUrl: string): ToolResult {
  const url = new URL(buildRequest(op, bindings, params, baseUrl).url)
  const mimeType = linkMimeType(op.responseMediaTypes, url)
  const name = linkName(op.path, url, mimeType)
  return {
    text: `File ${name}${mimeType ? ` (${mimeType})` : ''}, not downloaded by this tool: ${url.href}`,
    resourceLink: { uri: url.href, name, ...(mimeType ? { mimeType } : {}) }
  }
}
