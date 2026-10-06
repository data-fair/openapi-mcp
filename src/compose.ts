import Debug from 'debug'
import { load, type LoadOptions } from './load.ts'
import { loadSpec, defaultProfile } from './spec.ts'
import { expandProfiles, selectProfiles } from './profiles.ts'
import { resolveSkills, skillEntries } from './skills.ts'
import { toolSetSnapshot } from './snapshot.ts'
import { localize } from './localize.ts'
import { validateIndex, type Index, type IndexService } from './index-contract.ts'
import type { AgentRoot, JsonSchema, Skill, Tool, ToolSet, AgentSkill, SkillBodyFetcher } from './types.ts'

const debug = Debug('openapi-mcp:compose')

export interface ServiceStatus {
  id: string
  openapi: string
  status: 'ok' | 'skipped' | 'error'
  tools: number
  reason?: string
  /** problems that do not stop the service from serving, e.g. profiles the index does not declare */
  warnings?: string[]
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

interface CachedDoc extends Cached<JsonSchema> { id: string, skillWarnings?: string[] }

interface LiveComposition extends Composition { key: string, rebuild (): Promise<boolean> }

/** Revalidate one resource. Returns whether its value changed (a 304 never does; a new failure does). */
async function fetchConditional<T> (entry: Cached<T>, fetchFn: typeof fetch, parse: (body: unknown) => T, read: (res: Response) => Promise<unknown> = res => res.json()): Promise<boolean> {
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
    entry.value = parse(await read(res))
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
  // Linked skill bodies, shared by every composition: fetched once, revalidated on refresh.
  // The first read of a URL is shared: a concurrent caller awaits it rather than finding it empty.
  const skillCache = new Map<string, { entry: Cached<string>, ready: Promise<unknown> }>()
  const readText = (res: Response) => res.text()
  const skillBodies: SkillBodyFetcher = async (url) => {
    let item = skillCache.get(url)
    if (!item) {
      const entry: Cached<string> = { url }
      item = { entry, ready: fetchConditional(entry, fetchFn, body => body as string, readText) }
      skillCache.set(url, item)
    }
    await item.ready
    const { entry } = item
    return entry.value !== undefined ? { text: entry.value } : { error: entry.error ?? 'not loaded' }
  }
  // Every skill of a document, whatever the request (every profile its skills name is selected):
  // what a service's status reports.
  const skillWarnings = async (skills: AgentSkill[] | undefined, base: string | undefined): Promise<string[]> =>
    (await resolveSkills(skills, new Set((skills ?? []).flatMap(s => s.profiles ?? [])), locale, base, skillBodies))
      .filter(s => s.error).map(s => `skill ${s.name}: ${s.error}`)
  const listeners = new Set<() => void>()
  const compositions = new Map<string, LiveComposition>()
  const pending = new Map<string, Promise<LiveComposition>>()

  /** Fetched, validated and $ref-inlined once per change; `load()` on the result is cheap. */
  const loadDoc = async (entry: CachedDoc): Promise<boolean> => {
    const changed = await fetchConditional(entry, fetchFn, json => json as JsonSchema)
    if (changed && entry.value) {
      try {
        entry.value = await loadSpec(entry.value, fetchFn)
        // fetched with the document, so a broken link shows in the service status at startup
        entry.skillWarnings = await skillWarnings(entry.value['x-agent']?.skills, entry.url)
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

  // The index is the deployment's profile vocabulary, the names agent configurations are
  // written with: a document name outside it is a typo or a profile no consumer can offer.
  // Reported rather than refused, so a service keeps serving what it does declare correctly.
  const vocabularyWarnings = (doc: JsonSchema): string[] | undefined => {
    const vocabulary = Object.keys(current.profiles ?? {})
    if (!vocabulary.length) return undefined
    const outside = Object.keys(rootOf(doc).profiles ?? {}).filter(p => !vocabulary.includes(p))
    return outside.length ? [`declares profiles absent from the index: ${outside.join(', ')}`] : undefined
  }

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
    skills.push(...await resolveSkills(current.skills, indexSelected, locale, indexEntry.url || undefined, skillBodies))
    if (skills.length) sections.push(skillEntries(skills))

    for (const d of orderedDocs().filter(d => !composeOptions?.services || composeOptions.services.includes(d.id))) {
      const status: ServiceStatus = { id: d.id, openapi: d.url, status: 'ok', tools: 0 }
      statuses.push(status)
      if (!d.value) { status.status = 'error'; status.reason = d.error ?? 'not loaded'; continue }
      const root = rootOf(d.value)
      const declared = Object.keys(root.profiles ?? {})
      const warnings = vocabularyWarnings(d.value)
      if (warnings) {
        status.warnings = warnings
        debug('%s %s', d.id, warnings[0])
      }
      // Which of this document's profiles the request reaches, through the index's includes
      // and the document's own: `full` in the index reaching `edit` here reaching `edit_datasets`.
      const selected = selectProfiles([...indexSelected], expandProfiles(root.profiles, current.profiles))
      const subset = declared.filter(p => selected.has(p))
      if (declared.length && !subset.length) { status.status = 'skipped'; status.reason = `declares none of [${requested.join(', ')}]`; continue }
      let ts: ToolSet
      try {
        ts = await load(d.value, { ...options, profiles: subset.length ? subset : requested, namePrefix: composeOptions?.namePrefix ?? options.namePrefix, documentUrl: d.url, skillBodies })
      } catch (err: any) {
        status.status = 'error'; status.reason = err?.message ?? String(err); continue
      }
      const collision = ts.tools.find(t => names.has(t.name))
      if (collision) { status.status = 'error'; status.reason = `tool name collision with ${names.get(collision.name)}: ${collision.name}`; continue }
      for (const t of ts.tools) names.set(t.name, d.id)
      tools.push(...ts.tools)
      status.tools = ts.tools.length
      const serviceSkills = ts.skills.map(s => ({ ...s, id: `${d.id}/${s.id}` }))
      skills.push(...serviceSkills)
      const serviceText = [skillEntries(serviceSkills), ts.guide].filter(Boolean).join('\n\n')
      if (serviceText) sections.push(`# ${d.value.info?.title ?? d.id}\n\n${serviceText}`)
      const failed = ts.skills.filter(s => s.error).map(s => `skill ${s.name}: ${s.error}`)
      if (failed.length) status.warnings = [...(status.warnings ?? []), ...failed]
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
    for (const { entry } of skillCache.values()) {
      if (await fetchConditional(entry, fetchFn, body => body as string, readText)) changed = true
    }
    // the composer-level status follows the bodies, not only the documents
    for (const d of docs.values()) {
      if (d.value) d.skillWarnings = await skillWarnings(d.value['x-agent']?.skills, d.url)
    }
    if (!changed) return false
    let any = false
    for (const c of compositions.values()) if (await c.rebuild()) any = true
    if (any) for (const cb of listeners) cb()
    return any
  }

  return {
    get index () { return current },
    get services () {
      return orderedDocs().map(d => {
        const status: ServiceStatus = { id: d.id, openapi: d.url, status: d.value ? 'ok' : 'error', tools: 0, reason: d.error }
        const warnings = d.value ? vocabularyWarnings(d.value) : undefined
        if (warnings) status.warnings = warnings
        const failed = d.skillWarnings ?? []
        if (failed.length) status.warnings = [...(status.warnings ?? []), ...failed]
        return status
      })
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
