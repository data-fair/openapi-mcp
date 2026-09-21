import type { JsonSchema } from '../types.ts'

const ATTACHMENT = 'http://schema.org/DigitalDocument'

/**
 * Turn a schema fetched from an API into one `compile` accepts, the way data-fair's own
 * line-editing form does before handing it to json-layout.
 *
 * Three steps, all of them load-bearing:
 * - `v2compat`, because dataset schemas carry vjsf-v2 keywords and compiling them raw
 *   renders pickers as plain sections while `getFieldSuggestions` refuses them;
 * - a string `layout` is shorthand for `{ comp }`, which the compat layer leaves as it
 *   found it;
 * - attachment and extension columns are hidden: an agent has no file to upload, and
 *   extension columns are computed by the API, so writing them is meaningless.
 */
export async function prepareSchema (fetched: JsonSchema): Promise<JsonSchema> {
  // Lazy: @json-layout/core is an optional peer, arriving with @json-layout/agents.
  const { v2compat } = await import('@json-layout/core/compat/v2')
  const schema: JsonSchema = v2compat(structuredClone(fetched))

  for (const property of Object.values<any>(schema.properties ?? {})) {
    if (typeof property.layout === 'string') property.layout = { comp: property.layout }
    const hide = (property['x-refersTo'] === ATTACHMENT && property.layout?.comp !== 'text-field') ||
      property['x-extension'] !== undefined
    if (hide) property.layout = { ...(property.layout ?? {}), comp: 'none' }
  }
  return schema
}
