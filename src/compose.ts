import Debug from 'debug'
import { load, type LoadOptions } from './load.ts'
import { loadSpec, defaultProfile } from './spec.ts'
import { expandProfiles, selectProfiles } from './profiles.ts'
import { buildSkills } from './skills.ts'
import { toolSetSnapshot } from './snapshot.ts'
import { localize } from './localize.ts'
import { validateIndex, type Index, type IndexService } from './index-contract.ts'
import type { AgentRoot, JsonSchema, Skill, Tool, ToolSet } from './types.ts'

const debug = Debug('openapi-mcp:compose')

export interface ServiceStatus {
  id: string
  openapi: string
  status: 'ok' | 'skipped' | 'error'
  tools: number
  reason?: string
}

export interface ProfileInfo {
  name: string
  title?: string
  description?: string
  includes?: string[]
  /** the services declaring this profile; empty for an index-only profile */
  services: string[]
}

export interface Composition {
  /** the current merged set; replaced, never mutated, when a refresh changes it */
  readonly toolSet: ToolSet
  readonly services: ServiceStatus[]
  /** called after a refresh that changed this composition's set; returns the unsubscribe */
  onChange (cb: (toolSet: ToolSet) => void): () => void
}

export interface Composer {
  readonly index: Index
  /** document-level statuses: `ok` or `error`, never `skipped` (that is per profile set) */
  readonly services: ServiceStatus[]
  /** every declared profile across the documents, expanded, index wording winning */
  profiles (): ProfileInfo[]
  /** memoized per distinct set and options; an empty or absent profile set means the default profile */
  compose (profiles?: string[], options?: ComposeOptions): Promise<Composition>
  /** conditional GETs for the index and every document; rebuilds what changed; true if any live set changed */
  refresh (): Promise<boolean>
  /** called after a refresh that changed at least one live composition */
  onChange (cb: () => void): () => void
}

/** What a compatibility route needs: a subset of the services, and the names its clients already have. */
export interface ComposeOptions {
  /** service ids to compose, in index order; absent means all */
  services?: string[]
  /** replaces every document's `x-agent.namePrefix` (`''` strips it) */
  namePrefix?: string
}

export type ComposerOptions = Omit<LoadOptions, 'profile' | 'profiles'>

/** One HTTP resource with its validators, fetched conditionally. */
interface Cached<T> {
  url: string
  etag?: string
  lastModified?: string
  value?: T
  error?: string
}

interface CachedDoc extends Cached<JsonSchema> { id: string }

interface LiveComposition extends Composition { key: string, rebuild (): Promise<boolean> }

/** Revalidate one resource. Returns whether its value changed (a 304 never does; a new failure does). */
async function fetchConditional<T> (entry: Cached<T>, fetchFn: typeof fetch, parse: (json: unknown) => T): Promise<boolean> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (entry.etag) headers['if-none-match'] = entry.etag
  if (entry.lastModified) headers['if-modified-since'] = entry.lastModified
  const had = entry.value !== undefined
  let res: Response
  try {
    res = await fetchFn(entry.url, { headers })
  } catch (err: any) {
    entry.error = `fetch failed: ${err?.message ?? err}`
    entry.value = undefined
    return had
  }
  if (res.status === 304) return false
  if (!res.ok) {
    entry.error = `HTTP ${res.status}`
    entry.value = undefined
    return had
  }
  entry.etag = res.headers.get('etag') ?? undefined
  entry.lastModified = res.headers.get('last-modified') ?? undefined
  try {
    entry.value = parse(await res.json())
    entry.error = undefined
  } catch (err: any) {
    entry.error = err?.message ?? String(err)
    entry.value = undefined
  }
  return true
}

const setKey = (profiles: string[], options?: ComposeOptions): string =>
  `${[...new Set(profiles)].sort().join(',')}|${(options?.services ?? []).join(',')}|${options?.namePrefix ?? '\u0000'}`

export async function createComposer (index: string | Index, options: ComposerOptions = {}): Promise<Composer> {
  const fetchFn = options.fetch ?? globalThis.fetch
  const locale = options.locale ?? 'en'

  const indexEntry: Cached<Index> = { url: typeof index === 'string' ? index : '' }
  if (typeof index === 'string') {
    await fetchConditional(indexEntry, fetchFn, validateIndex)
    if (!indexEntry.value) throw new Error(`failed to load index ${index}: ${indexEntry.error}`)
  } else {
    indexEntry.value = validateIndex(index)
  }
  let current: Index = indexEntry.value

  const docs = new Map<string, CachedDoc>()
  const listeners = new Set<() => void>()
  const compositions = new Map<string, LiveComposition>()
  const pending = new Map<string, Promise<LiveComposition>>()

  /** Fetched, validated and $ref-inlined once per change; `load()` on the result is cheap. */
  const loadDoc = async (entry: CachedDoc): Promise<boolean> => {
    const changed = await fetchConditional(entry, fetchFn, json => json as JsonSchema)
    if (changed && entry.value) {
      try {
        entry.value = await loadSpec(entry.value, fetchFn)
      } catch (err: any) {
        entry.error = err?.message ?? String(err)
        entry.value = undefined
      }
    }
    return changed
  }
  const syncServices = async (): Promise<boolean> => {
    let changed = false
    const ids = new Set(current.services.map(s => s.id))
    for (const id of [...docs.keys()]) {
      if (!ids.has(id)) { docs.delete(id); changed = true }
    }
    await Promise.all(current.services.map(async (s: IndexService) => {
      let entry = docs.get(s.id)
      if (!entry || entry.url !== s.openapi) {
        entry = { id: s.id, url: s.openapi }
        docs.set(s.id, entry)
      }
      if (await loadDoc(entry)) changed = true
    }))
    return changed
  }
  await syncServices()

  const orderedDocs = () => current.services.map(s => docs.get(s.id)).filter((d): d is CachedDoc => d !== undefined)
  const rootOf = (doc: JsonSchema): AgentRoot => doc['x-agent'] ?? {}

  const defaultProfiles = (): string[] => {
    const first = Object.keys(current.profiles ?? {})[0]
    if (first) return [first]
    const doc = orderedDocs().find(d => d.value)?.value
    return [doc ? defaultProfile(doc) : 'default']
  }

  const profiles = (): ProfileInfo[] => {
    const out = new Map<string, ProfileInfo>()
    for (const [name, p] of Object.entries(current.profiles ?? {})) {
      out.set(name, { name, title: localize(p.title, locale), description: localize(p.description, locale), includes: p.includes, services: [] })
    }
    for (const d of orderedDocs()) {
      if (!d.value) continue
      for (const [name, p] of Object.entries(rootOf(d.value).profiles ?? {})) {
        const info = out.get(name) ?? { name, services: [] }
        info.title ??= localize(p.title, locale)
        info.description ??= localize(p.description, locale)
        if (!info.includes && p.includes) info.includes = p.includes
        info.services.push(d.id)
        out.set(name, info)
      }
    }
    return [...out.values()]
  }

  const build = async (requested: string[], composeOptions?: ComposeOptions): Promise<{ toolSet: ToolSet, services: ServiceStatus[] }> => {
    const tools: Tool[] = []
    const names = new Map<string, string>()
    const sections: string[] = []
    const skills: Skill[] = []
    const statuses: ServiceStatus[] = []
    const indexSelected = selectProfiles(requested, expandProfiles(undefined, current.profiles))
    skills.push(...buildSkills(current.skills, indexSelected, locale))
    for (const s of skills) sections.push(`## ${s.name}\n\n${s.body}`)

    for (const d of orderedDocs().filter(d => !composeOptions?.services || composeOptions.services.includes(d.id))) {
      const status: ServiceStatus = { id: d.id, openapi: d.url, status: 'ok', tools: 0 }
      statuses.push(status)
      if (!d.value) { status.status = 'error'; status.reason = d.error ?? 'not loaded'; continue }
      const root = rootOf(d.value)
      const declared = Object.keys(root.profiles ?? {})
      // Which of this document's profiles the request reaches, through the index's includes
      // and the document's own: `full` in the index reaching `edit` here reaching `edit_datasets`.
      const selected = selectProfiles([...indexSelected], expandProfiles(root.profiles, current.profiles))
      const subset = declared.filter(p => selected.has(p))
      if (declared.length && !subset.length) { status.status = 'skipped'; status.reason = `declares none of [${requested.join(', ')}]`; continue }
      let ts: ToolSet
      try {
        ts = await load(d.value, { ...options, profiles: subset.length ? subset : requested, namePrefix: composeOptions?.namePrefix })
      } catch (err: any) {
        status.status = 'error'; status.reason = err?.message ?? String(err); continue
      }
      const collision = ts.tools.find(t => names.has(t.name))
      if (collision) { status.status = 'error'; status.reason = `tool name collision with ${names.get(collision.name)}: ${collision.name}`; continue }
      for (const t of ts.tools) names.set(t.name, d.id)
      tools.push(...ts.tools)
      status.tools = ts.tools.length
      if (ts.instructions) sections.push(`# ${d.value.info?.title ?? d.id}\n\n${ts.instructions}`)
      skills.push(...ts.skills.map(s => ({ ...s, id: `${d.id}/${s.id}` })))
    }
    return { toolSet: { profiles: requested, instructions: sections.join('\n\n'), tools, skills }, services: statuses }
  }

  const makeComposition = async (requested: string[], composeOptions?: ComposeOptions): Promise<LiveComposition> => {
    const changeListeners = new Set<(toolSet: ToolSet) => void>()
    let built = await build(requested, composeOptions)
    let snapshot = JSON.stringify(toolSetSnapshot(built.toolSet))
    return {
      key: setKey(requested, composeOptions),
      get toolSet () { return built.toolSet },
      get services () { return built.services },
      onChange (cb) { changeListeners.add(cb); return () => changeListeners.delete(cb) },
      async rebuild () {
        const next = await build(requested, composeOptions)
        const nextSnapshot = JSON.stringify(toolSetSnapshot(next.toolSet))
        built = next
        if (nextSnapshot === snapshot) return false
        snapshot = nextSnapshot
        for (const cb of changeListeners) cb(built.toolSet)
        return true
      }
    }
  }

  const compose = (requested?: string[], composeOptions?: ComposeOptions): Promise<Composition> => {
    const profilesRequested = requested?.length ? requested : defaultProfiles()
    const key = setKey(profilesRequested, composeOptions)
    let p = pending.get(key)
    if (!p) {
      p = makeComposition(profilesRequested, composeOptions).then(c => { compositions.set(key, c); return c })
      pending.set(key, p)
    }
    return p
  }

  const refresh = async (): Promise<boolean> => {
    let changed = false
    if (indexEntry.url && await fetchConditional(indexEntry, fetchFn, validateIndex)) {
      if (indexEntry.value) { current = indexEntry.value; changed = true } else debug('index refresh failed: %s', indexEntry.error)
    }
    if (await syncServices()) changed = true
    if (!changed) return false
    let any = false
    for (const c of compositions.values()) if (await c.rebuild()) any = true
    if (any) for (const cb of listeners) cb()
    return any
  }

  return {
    get index () { return current },
    get services () {
      return orderedDocs().map(d => ({ id: d.id, openapi: d.url, status: d.value ? 'ok' as const : 'error' as const, tools: 0, reason: d.error }))
    },
    profiles,
    compose,
    refresh,
    onChange (cb) { listeners.add(cb); return () => listeners.delete(cb) }
  }
}

/** One profile set over an index, in one call. */
export async function compose (index: string | Index, options: ComposerOptions & { profiles?: string[] } & ComposeOptions = {}): Promise<Composition> {
  const { profiles, services, namePrefix, ...rest } = options
  const composer = await createComposer(index, rest)
  return composer.compose(profiles, { services, namePrefix })
}
