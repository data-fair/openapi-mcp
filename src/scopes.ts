import { skillEntries } from './skills.ts'
import type { SecurityRequirement, ToolSet } from './types.ts'

/**
 * Whether a token holding `scopes` meets one alternative of `security`: the public one (`{}`,
 * or no alternative at all with `security: []`), or an `oauth2` requirement whose scopes it
 * holds every one of. Membership is exact: a service lists each scope it accepts, umbrella
 * included, as an alternative of its own. No security declared at all is not public.
 */
function granted (security: SecurityRequirement[] | undefined, scopes: string[]): boolean {
  if (!security) return false
  if (security.length === 0) return true
  return security.some(requirement => {
    const schemes = Object.keys(requirement)
    if (schemes.length === 0) return true
    return schemes.length === 1 && schemes[0] === 'oauth2' && requirement.oauth2.every(s => scopes.includes(s))
  })
}

/**
 * The part of a tool set a scoped token can use: the tools its scopes grant, and the skills
 * still driving one of them (a skill naming no tools stays). `undefined` is an unscoped
 * session, which keeps the tool set as it is.
 */
export function toolsForScopes (toolSet: ToolSet, scopes: string[] | undefined): ToolSet {
  if (scopes === undefined) return toolSet
  const tools = toolSet.tools.filter(t => granted(t.security, scopes))
  const kept = new Set(tools.map(t => t.name))
  const skills = toolSet.skills.filter(s => !s.tools?.length || s.tools.some(t => kept.has(t)))
  const instructions = [skillEntries(skills), toolSet.guide].filter(Boolean).join('\n\n')
  return { ...toolSet, instructions, tools, skills }
}
