import type { Localized } from './types.ts'

export function localize (value: Localized | undefined, locale: string): string | undefined {
  if (value === undefined || typeof value === 'string') return value
  return value[locale] ?? value.en ?? Object.values(value)[0]
}

// values, not annotations: an object under these keys is data, whatever its keys
const DATA_KEYWORDS = new Set(['const', 'default', 'enum', 'examples', 'example'])
// maps of names (a property named "layout" stays) whose values are schemas
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])
// json-layout display annotations: how vjsf renders a form, nothing a tool call needs. A form tool
// reads its schema from the document (or its schemaOperation), never from a tool definition.
const DISPLAY_KEYWORDS = new Set(['layout', 'oneOfLayout', 'patternPropertiesLayout'])

/**
 * A copy of a JSON schema for a tool definition, in one language and without display annotations:
 * each `x-i18n-<key>` annotation (json-layout's, `{ fr: '…', en: '…' }`) replaces `<key>` with its
 * translation in the locale, the original kept when it has none, and is dropped; json-layout's
 * `layout`, `oneOfLayout` and `patternPropertiesLayout` are dropped. A document keeps them for the readers that render forms
 * and translate per viewer (vjsf); a tool definition is read in its locale, and the rest would only
 * weigh on it.
 */
export function localizeSchema<T> (schema: T, locale: string): T {
  if (Array.isArray(schema)) return schema.map(item => localizeSchema(item, locale)) as T
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, any> = {}
  const translations: Record<string, string> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith('x-i18n-') && value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value[locale] === 'string') translations[key.slice('x-i18n-'.length)] = value[locale]
    } else if (DISPLAY_KEYWORDS.has(key)) {
      continue
    } else if (SCHEMA_MAPS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, s]) => [name, localizeSchema(s, locale)]))
    } else {
      out[key] = DATA_KEYWORDS.has(key) ? value : localizeSchema(value, locale)
    }
  }
  return Object.assign(out, translations) as T
}
