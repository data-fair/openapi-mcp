import type { Localized } from './types.ts'

export function localize (value: Localized | undefined, locale: string): string | undefined {
  if (value === undefined || typeof value === 'string') return value
  return value[locale] ?? value.en ?? Object.values(value)[0]
}
