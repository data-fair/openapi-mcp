import type { Localized } from './types.ts'

export type ProfileDeclarations = Record<string, { title?: Localized, description?: Localized, includes?: string[] }>

/**
 * Every profile name → the set of profiles it selects: itself and, transitively, what it
 * includes. `declared` is a document's own map, checked strictly: an include must name a
 * declared profile and must not form a cycle. `extra` is an index's map, whose includes may
 * reach names this document never declares (a stack-wide `full` including `admin` on a
 * service without admin operations selects nothing there, which is not an error).
 */
export function expandProfiles (declared: ProfileDeclarations | undefined, extra?: Record<string, { includes?: string[] }>): Map<string, Set<string>> {
  const includes = new Map<string, string[]>()
  for (const [name, p] of Object.entries(extra ?? {})) includes.set(name, [...(p.includes ?? [])])
  for (const [name, p] of Object.entries(declared ?? {})) {
    for (const inc of p.includes ?? []) {
      if (!(inc in declared!)) throw new Error(`profile "${name}" includes "${inc}", which is not declared`)
    }
    includes.set(name, [...(includes.get(name) ?? []), ...(p.includes ?? [])])
  }
  const out = new Map<string, Set<string>>()
  const expand = (name: string, trail: string[]): Set<string> => {
    const done = out.get(name)
    if (done) return done
    if (trail.includes(name)) throw new Error(`profile includes form a cycle: ${[...trail, name].join(' → ')}`)
    const set = new Set([name])
    for (const inc of includes.get(name) ?? []) for (const n of expand(inc, [...trail, name])) set.add(n)
    out.set(name, set)
    return set
  }
  for (const name of includes.keys()) expand(name, [])
  return out
}

/** The union of the requested profiles' expansions. A name nothing declares selects itself. */
export function selectProfiles (requested: string[], expanded: Map<string, Set<string>>): Set<string> {
  const set = new Set<string>()
  for (const r of requested) for (const n of expanded.get(r) ?? [r]) set.add(n)
  return set
}

export function matchesProfiles (profiles: string[] | true, selected: Set<string>): boolean {
  return profiles === true || profiles.some(p => selected.has(p))
}
