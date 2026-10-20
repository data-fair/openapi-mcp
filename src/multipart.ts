import { PassThrough, Readable } from 'node:stream'
import FormData from 'form-data'

/** An opened file: its bytes are read once. */
export interface FileSource {
  /** the file name, decoded from the URL's last path segment */
  name: string
  /** the source's Content-Type, if it sent one */
  contentType?: string
  /** the source's Content-Length: what the upstream Content-Length is computed from */
  size: number
  /** exactly `size` bytes; the stream errors when the source sends more or fewer */
  body: Readable
  /** releases the source's connection; harmless once the bytes are read */
  close (): void
}

export type Part = { name: string, value: string } | { name: string, file: FileSource, contentType: string }

export interface EncodedBody {
  contentType: string
  /** the exact byte length of `body`: the request is sent with a Content-Length, never chunked */
  length: number
  body: ReadableStream<Uint8Array>
}

const toWeb = (stream: Readable) => Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>

/**
 * multipart/form-data through the `form-data` package. Each file is appended with its known
 * length, so `getLengthSync()` is the exact body length before the first byte. Field parts go
 * first: a server that filters files as they arrive (multer) has only seen the fields sent
 * before them.
 */
export function encodeMultipart (parts: Part[]): EncodedBody {
  const form = new FormData()
  for (const p of parts) if ('value' in p) form.append(p.name, p.value)
  for (const p of parts) if ('file' in p) form.append(p.name, p.file.body, { knownLength: p.file.size, filename: p.file.name, contentType: p.contentType })
  // FormData re-emits a part's error, but pipe() does not forward it to the destination.
  const body = new PassThrough()
  form.on('error', err => body.destroy(err))
  form.pipe(body)
  return { contentType: form.getHeaders()['content-type'], length: form.getLengthSync(), body: toWeb(body) }
}

/** A raw body that is the bytes of one file. */
export function encodeRaw (file: FileSource, contentType: string): EncodedBody {
  return { contentType, length: file.size, body: toWeb(file.body) }
}

/**
 * A multipart field's text: objects and arrays as JSON (OpenAPI's default content type for such
 * a part), scalars as their string form. An absent value sends no part.
 */
export function partValue (value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
