import http from 'node:http'
import https from 'node:https'
import { Transform, type Readable } from 'node:stream'
import type { Binding } from './input.ts'
import type { FileSource } from './multipart.ts'

/**
 * File inputs are indirect uploads: the server fetches the presigned URLs a file store signs for
 * its caller, and nothing else. `urlPrefixes` names that store (endpoint and bucket path); without
 * one, file inputs are off.
 */
export interface FileLoadOptions {
  /** URL prefixes of the file store, matched at a boundary on the normalized URL; none: file inputs off */
  urlPrefixes?: string[]
  /** the largest file accepted, in bytes; also published as `x-mcp-file.maxSize` (default 100 MiB) */
  maxSize?: number
  /** milliseconds from the request to the last byte (default 300000) */
  timeout?: number
}

export interface FileFetcher {
  readonly maxSize: number
  open (url: string, signal?: AbortSignal): Promise<FileSource>
}

export const FILE_DEFAULTS = { maxSize: 100 * 1024 * 1024, timeout: 300_000 } as const

/** A configured prefix in the form URLs are compared in: http(s) only, never with credentials. */
function normalizePrefix (prefix: string): string {
  let url: URL
  try {
    url = new URL(prefix)
  } catch {
    throw new Error(`files.urlPrefixes: "${prefix}" is not a URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`files.urlPrefixes: "${prefix}" is not an http or https URL`)
  if (url.username || url.password) throw new Error(`files.urlPrefixes: "${prefix}" carries credentials`)
  return url.href
}

/**
 * Whether a normalized URL is under one of the prefixes, at a boundary: `…/bucket` admits
 * `…/bucket/x` and `…/bucket?x`, never `…/bucket-evil/x`. A prefix ending with `/`, `?`, `&` or
 * `=` is its own boundary.
 */
export function underPrefix (href: string, prefixes: string[]): boolean {
  return prefixes.some(p => {
    if (!href.startsWith(p)) return false
    if (/[/?&=]$/.test(p)) return true
    const next = href.charAt(p.length)
    return next === '' || next === '/' || next === '?'
  })
}

/** The file name a URL carries: its last path segment, decoded. An API may type an upload by it. */
export function fileName (url: URL): string {
  const last = url.pathname.split('/').pop() ?? ''
  let name = last
  try { name = decodeURIComponent(last) } catch {}
  if (!name) throw new Error('the URL does not end with a file name (…/report.csv)')
  return name
}

/** A URL as a message may show it: without its query string, which may carry a signature. */
export function displayUrl (raw: string): string {
  try {
    const url = new URL(raw)
    return url.origin + url.pathname
  } catch {
    return '(not a URL)'
  }
}

/**
 * The source's bytes, failing when it sends more or fewer than it declared: an upload is never
 * sent truncated. With the declared length checked before reading, this one counter is the
 * whole size cap.
 */
function counted (source: Readable, size: number, failure: (err: unknown, read: number) => Error): Readable {
  let read = 0
  const out = new Transform({
    transform (chunk: Buffer, _encoding, callback) {
      read += chunk.length
      callback(read > size ? new Error(`the source sent more than its Content-Length of ${size} bytes`) : null, chunk)
    },
    flush (callback) {
      callback(read < size ? new Error(`the source sent ${read} of ${size} bytes`) : null)
    }
  })
  // pipe() does not forward a source's error
  source.on('error', err => out.destroy(failure(err, read)))
  return source.pipe(out)
}

/**
 * A plain GET with Node's http/https: no headers of the call, no redirect followed, no
 * decompression (Node never decodes, and asks for no encoding). The host is a fixed, trusted
 * endpoint named by configuration, so no address checks are needed beyond the prefix.
 */
export function createFileFetcher (options: FileLoadOptions = {}): FileFetcher | undefined {
  const prefixes = (options.urlPrefixes ?? []).map(normalizePrefix)
  if (!prefixes.length) return undefined
  const maxSize = options.maxSize ?? FILE_DEFAULTS.maxSize
  const timeout = options.timeout ?? FILE_DEFAULTS.timeout

  const get = (url: URL, signal: AbortSignal) => new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(url, { signal }, resolve)
    req.on('error', reject)
  })

  async function open (raw: string, signal?: AbortSignal): Promise<FileSource> {
    // Matched on the parsed URL: dot segments resolved, host lower-cased, default port dropped.
    // A prefix has an http(s) scheme and no credentials, so a match has neither.
    const url = new URL(raw)
    if (!underPrefix(url.href, prefixes)) throw new Error('not a file store URL: only URLs under the configured file URL prefixes are fetched')
    const name = fileName(url)
    // One deadline for the response and the whole transfer, combined with the caller's abort.
    const deadline = AbortSignal.timeout(timeout)
    const timedOut = () => new Error(`timed out after ${timeout} ms`)
    let res: http.IncomingMessage
    try {
      res = await get(url, signal ? AbortSignal.any([signal, deadline]) : deadline)
    } catch (err) {
      throw deadline.aborted ? timedOut() : err
    }
    const status = res.statusCode ?? 0
    if (status < 200 || status >= 300) {
      res.destroy()
      throw new Error(status >= 300 && status < 400 ? `HTTP ${status}: redirects are not followed (a presigned URL answers directly)` : `HTTP ${status}`)
    }
    // Compressed bytes are not the file, and decoding them would lose the length the upload needs.
    const encoding = res.headers['content-encoding']
    if (encoding && encoding !== 'identity') {
      res.destroy()
      throw new Error(`the response is encoded (${encoding}): its bytes are not the file`)
    }
    const length = res.headers['content-length']
    if (length === undefined) {
      res.destroy()
      throw new Error('the response has no Content-Length: the file is sent upstream with an exact length, so its size must be known before it is read')
    }
    const size = Number(length)
    if (size > maxSize) {
      res.destroy()
      throw new Error(`the file is ${size} bytes, over the ${maxSize} bytes limit`)
    }
    const body = counted(res, size, (err: any, read) => deadline.aborted ? timedOut() : new Error(`the source failed after ${read} of ${size} bytes (${err?.message ?? err})`))
    // Until the upload attaches to it, the body has no consumer and an error would be thrown as
    // uncaught: keep it (body.errored) for openFiles, and the upload's own listeners see it later.
    body.on('error', () => {})
    return { name, contentType: res.headers['content-type'], size, body, close: () => { res.destroy(); body.destroy() } }
  }

  return { maxSize, open }
}

export function closeFiles (files: Record<string, FileSource>): void {
  for (const f of Object.values(files)) f.close()
}

/**
 * Open the file of every file input given, keyed by input name. All are opened (headers read)
 * before the upstream request: its Content-Length needs every size. A failure closes the
 * others and names the input, with the URL shown without its query string.
 */
export async function openFiles (bindings: Binding[], params: Record<string, unknown>, fetcher: FileFetcher, signal?: AbortSignal): Promise<Record<string, FileSource>> {
  const opened: Record<string, FileSource> = {}
  for (const b of bindings) {
    const url = params[b.toolName]
    if (b.kind !== 'file' || typeof url !== 'string') continue
    try {
      opened[b.toolName] = await fetcher.open(url, signal)
    } catch (err: any) {
      closeFiles(opened)
      throw new Error(`File "${b.toolName}" (${displayUrl(url)}) could not be fetched: ${err?.message ?? err}`)
    }
  }
  // A source may have failed while a later one was being opened.
  for (const b of bindings) {
    const f = opened[b.toolName]
    if (f?.body.errored) {
      closeFiles(opened)
      throw new Error(`File "${b.toolName}" (${displayUrl(params[b.toolName] as string)}) could not be fetched: ${f.body.errored.message}`)
    }
  }
  return opened
}
