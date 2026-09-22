import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats'
import type { AgentSkill, Localized } from './types.ts'

// Same CJS/NodeNext typing quirk as load.ts: the callable default is typed as the namespace.
const addFormats = addFormatsModule as unknown as FormatsPlugin

export interface IndexService { id: string, openapi: string }
export interface IndexProfile { title?: Localized, description?: Localized, includes?: string[] }

/** The one document this library dictates the shape of: a deployment's service-level documents. */
export interface Index {
  version: 1
  services: IndexService[]
  profiles?: Record<string, IndexProfile>
  skills?: AgentSkill[]
}

const localized = { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: { type: 'string' }, minProperties: 1 }] }

export const indexSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'services'],
  properties: {
    version: { const: 1 },
    services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'openapi'],
        properties: { id: { type: 'string', pattern: '^[a-z0-9-]+$' }, openapi: { type: 'string', format: 'uri' } }
      }
    },
    profiles: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: { title: localized, description: localized, includes: { type: 'array', items: { type: 'string' }, minItems: 1 } }
      }
    },
    skills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 },
          description: localized,
          profiles: { type: 'array', items: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validate = ajv.compile(indexSchema)

/** Throws naming the first offending path; returns the typed index otherwise. */
export function validateIndex (value: unknown): Index {
  if (!validate(value)) {
    const msg = validate.errors!.map(e => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`).join('; ')
    throw new Error(`index invalid: ${msg}`)
  }
  const index = value as unknown as Index
  const seen = new Set<string>()
  for (const s of index.services) {
    if (seen.has(s.id)) throw new Error(`index invalid: duplicate service id "${s.id}"`)
    seen.add(s.id)
  }
  return index
}
