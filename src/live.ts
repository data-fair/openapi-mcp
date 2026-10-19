import Debug from 'debug'
import { load, type LoadOptions } from './load.ts'
import { toolSetSnapshot } from './snapshot.ts'
import type { JsonSchema, SkillBodyFetcher, ToolSet } from './types.ts'

const debug = Debug('openapi-mcp:live')

export interface LiveDocument {
  /** the current tool set; replaced, never mutated, when a refresh changes it */
  readonly toolSet: ToolSet
  /** why the last refresh could not rebuild the tool set; the previous one is kept meanwhile */
  readonly error?: string
  /** conditional GETs of the document and of its linked skill bodies; true when `toolSet` changed */
  refresh (): Promise<boolean>
  /** called after a refresh that changed the tool set; returns the unsubscribe */
  onChange (cb: (toolSet: ToolSet) => void): () => void
}

/** One HTTP resource with its validators, fetched conditionally. */
interface Cached<T> {
  url: string
  etag?: string
  lastModified?: string
  value?: T
  error?: string
}

const JSON_ACCEPT = 'application/json'
const SKILL_ACCEPT = 'text/markdown, text/plain;q=0.9, */*;q=0.1'

/** Revalidate one resource. Returns whether its value changed (a 304 never does; a new failure does). */
async function fetchConditional<T> (entry: Cached<T>, fetchFn: typeof fetch, accept: string, read: (res: Response) => Promise<T>): Promise<boolean> {
  const headers: Record<string, string> = { accept }
  if (entry.etag) headers['if-none-match'] = entry.etag
  if (entry.lastModified) headers['if-modified-since'] = entry.lastModified
  const had = entry.value !== undefined
  let res: Response
  try {
    res = await fetchFn(entry.url, { headers })
  } catch (err: any) {
    entry.error = `fetch failed: ${err?.message ?? err}`
    entry.value = undefined
    // without a value, a 304 on the next revalidation could never restore it
    entry.etag = entry.lastModified = undefined
    return had
  }
  if (res.status === 304) return false
  if (!res.ok) {
    entry.error = `HTTP ${res.status}`
    entry.value = undefined
    entry.etag = entry.lastModified = undefined
    return had
  }
  entry.etag = res.headers.get('etag') ?? undefined
  entry.lastModified = res.headers.get('last-modified') ?? undefined
  try {
    entry.value = await read(res)
    entry.error = undefined
  } catch (err: any) {
    entry.error = err?.message ?? String(err)
    entry.value = undefined
    entry.etag = entry.lastModified = undefined
  }
  return true
}

/** What an agent is served: the snapshot misses the instructions, which tag guides change. */
const fingerprint = (toolSet: ToolSet): string =>
  JSON.stringify([toolSetSnapshot(toolSet), toolSet.instructions, toolSet.guideInstructions ?? null])

/**
 * One document URL kept current: `refresh()` revalidates it and its linked skill bodies with
 * conditional requests and rebuilds the tool set when one of them changed. The library runs no
 * timer; the caller decides when to refresh. `documentUrl` and `skillBodies` are set from `url`
 * and the body cache. The first load throws on failure; a later one keeps the previous tool set.
 */
export async function createLiveDocument (url: string, options: LoadOptions = {}): Promise<LiveDocument> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const docEntry: Cached<JsonSchema> = { url }

  // Linked skill bodies: fetched once, revalidated on refresh. The first read of a URL is shared,
  // so a concurrent caller awaits it rather than finding it empty.
  const skillCache = new Map<string, { entry: Cached<string>, ready: Promise<unknown> }>()
  let used = new Set<string>()
  const readText = (res: Response) => res.text()
  const skillBodies: SkillBodyFetcher = async (bodyUrl) => {
    used.add(bodyUrl)
    let item = skillCache.get(bodyUrl)
    if (!item) {
      const entry: Cached<string> = { url: bodyUrl }
      item = { entry, ready: fetchConditional(entry, fetchFn, SKILL_ACCEPT, readText) }
      skillCache.set(bodyUrl, item)
    }
    await item.ready
    const { entry } = item
    return entry.value !== undefined ? { text: entry.value } : { error: entry.error ?? 'not loaded' }
  }

  const build = async (current: JsonSchema): Promise<ToolSet> => {
    used = new Set()
    const toolSet = await load(current, { ...options, fetch: fetchFn, documentUrl: url, skillBodies })
    // a link the document no longer carries is not revalidated forever
    for (const bodyUrl of [...skillCache.keys()]) if (!used.has(bodyUrl)) skillCache.delete(bodyUrl)
    return toolSet
  }

  await fetchConditional(docEntry, fetchFn, JSON_ACCEPT, res => res.json())
  if (!docEntry.value) throw new Error(`failed to load ${url}: ${docEntry.error}`)
  // The last document that answered: a failed revalidation must not lose what the bodies rebuild from.
  let doc: JsonSchema = docEntry.value
  let toolSet = await build(doc)
  let snapshot = fingerprint(toolSet)
  let error: string | undefined
  const listeners = new Set<(toolSet: ToolSet) => void>()

  const revalidate = async (): Promise<boolean> => {
    let changed = await fetchConditional(docEntry, fetchFn, JSON_ACCEPT, res => res.json())
    if (docEntry.error) {
      error = `failed to load ${url}: ${docEntry.error}`
      debug('%s', error)
      return false
    }
    if (docEntry.value) doc = docEntry.value
    for (const { entry } of skillCache.values()) {
      if (await fetchConditional(entry, fetchFn, SKILL_ACCEPT, readText)) changed = true
    }
    // nothing answered differently, and the last build succeeded: the set cannot have changed
    if (!changed && !error) return false
    let next: ToolSet
    try {
      next = await build(doc)
    } catch (err: any) {
      error = err?.message ?? String(err)
      debug('rebuild of %s failed: %s', url, error)
      return false
    }
    error = undefined
    const nextSnapshot = fingerprint(next)
    // new bytes saying the same thing (a new ETag, a recovered document) are not a change
    if (nextSnapshot === snapshot) return false
    toolSet = next
    snapshot = nextSnapshot
    for (const cb of listeners) cb(toolSet)
    return true
  }

  // Overlapping calls (a slow upstream under a short timer) share the one in flight.
  let inFlight: Promise<boolean> | undefined
  return {
    get toolSet () { return toolSet },
    get error () { return error },
    refresh () {
      inFlight ??= revalidate().finally(() => { inFlight = undefined })
      return inFlight
    },
    onChange (cb) { listeners.add(cb); return () => listeners.delete(cb) }
  }
}
