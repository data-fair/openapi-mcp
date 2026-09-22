import type { JsonSchema } from '../types.ts'

const localized: JsonSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: { type: 'string' }, minProperties: 1 }
  ]
}
const profiles: JsonSchema = { oneOf: [{ const: true }, { type: 'array', items: { type: 'string' }, minItems: 1 }] }
const annotations: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { readOnlyHint: { type: 'boolean' }, destructiveHint: { type: 'boolean' }, idempotentHint: { type: 'boolean' }, openWorldHint: { type: 'boolean' } }
}

export const paramOverrideSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$' },
    description: localized,
    exclude: { type: 'boolean' },
    default: {},
    maximum: { type: 'number' },
    enum: { type: 'array', minItems: 1 },
    required: { type: 'boolean' }
  }
}

export const rootSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    namePrefix: { type: 'string', pattern: '^[a-z0-9_]*$' },
    profiles: {
      type: 'object',
      minProperties: 1,
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
          // The MCP skills extension requires `name` to equal the last URI segment and
          // delegates its format to the Agent Skills specification.
          name: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 },
          description: localized,
          profiles: { type: 'array', items: { type: 'string' } },
          tools: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
}

export const tagSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { profiles, skill: localized }
}

export const operationSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    profiles,
    name: { type: 'string', pattern: '^[a-z0-9_]+$' },
    title: localized,
    description: localized,
    examples: { type: 'array', items: { type: 'object' } },
    annotations,
    params: { type: 'object', additionalProperties: paramOverrideSchema },
    fixed: { type: 'object' },
    body: { enum: ['flat', 'compact'] },
    response: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rows: { type: 'string', pattern: '^/[^/]+$' },
        concise: { type: 'array', items: { type: 'string' }, minItems: 1 },
        detailed: { oneOf: [{ const: true }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
        selectParam: { type: 'string' },
        hints: { type: 'boolean' }
      }
    },
    editor: {
      oneOf: [
        { const: true },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            schemaOperation: { type: 'string' },
            schemaParams: { type: 'object' },
            readOperation: { type: 'string' }
          }
        }
      ]
    }
  }
}

export const propertySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { hint: localized, exclude: { type: 'boolean' } }
}
