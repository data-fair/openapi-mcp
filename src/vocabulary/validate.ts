import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject } from 'ajv/dist/2020.js'
import { rootSchema, tagSchema, operationSchema, paramOverrideSchema, propertySchema } from './schema.ts'
import type { JsonSchema } from '../types.ts'

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validators = {
  root: ajv.compile(rootSchema),
  tag: ajv.compile(tagSchema),
  operation: ajv.compile(operationSchema),
  param: ajv.compile(paramOverrideSchema),
  property: ajv.compile(propertySchema)
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']

/** JSON pointer escaping for error paths */
const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1')

function check (kind: keyof typeof validators, value: unknown, path: string) {
  const validate = validators[kind]
  if (!validate(value)) {
    const msg = validate.errors!.map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`).join('; ')
    throw new Error(`x-agent invalid at ${path || '/'}: ${msg}`)
  }
}

/** Recursively validate x-agent on every schema property (response bodies, request bodies, parameter schemas). */
function checkSchema (schema: JsonSchema | undefined, path: string, seen = new Set<object>()) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return
  seen.add(schema)
  if (schema['x-agent'] !== undefined) check('property', schema['x-agent'], path)
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const map = schema[key]
    if (map && typeof map === 'object') for (const [k, v] of Object.entries(map)) checkSchema(v as JsonSchema, `${path}/${key}/${esc(k)}`, seen)
  }
  for (const key of ['items', 'additionalProperties', 'not']) if (schema[key] && typeof schema[key] === 'object') checkSchema(schema[key], `${path}/${key}`, seen)
  for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(schema[key])) schema[key].forEach((s: JsonSchema, i: number) => checkSchema(s, `${path}/${key}/${i}`, seen))
  }
}

function checkParams (params: any[] | undefined, path: string) {
  if (!Array.isArray(params)) return
  params.forEach((p, i) => {
    if (p?.['x-agent'] !== undefined) check('param', p['x-agent'], `${path}/${i}`)
    checkSchema(p?.schema, `${path}/${i}/schema`)
  })
}

/** Throws on the first invalid x-agent object found anywhere in the OpenAPI document. */
export function validateVocabulary (doc: JsonSchema): void {
  if (doc['x-agent'] !== undefined) check('root', doc['x-agent'], '/')
  if (Array.isArray(doc.tags)) doc.tags.forEach((t: any, i: number) => { if (t?.['x-agent'] !== undefined) check('tag', t['x-agent'], `/tags/${i}`) })
  for (const [p, item] of Object.entries<any>(doc.paths ?? {})) {
    const itemPath = `/paths/${esc(p)}`
    checkParams(item?.parameters, `${itemPath}/parameters`)
    for (const m of METHODS) {
      const op = item?.[m]
      if (!op) continue
      const opPath = `${itemPath}/${m}`
      if (op['x-agent'] !== undefined) check('operation', op['x-agent'], opPath)
      checkParams(op.parameters, `${opPath}/parameters`)
      for (const [mt, media] of Object.entries<any>(op.requestBody?.content ?? {})) checkSchema(media?.schema, `${opPath}/requestBody/content/${esc(mt)}/schema`)
      for (const [code, resp] of Object.entries<any>(op.responses ?? {})) {
        for (const [mt, media] of Object.entries<any>(resp?.content ?? {})) checkSchema(media?.schema, `${opPath}/responses/${code}/content/${esc(mt)}/schema`)
      }
    }
  }
  for (const [name, schema] of Object.entries<any>(doc.components?.schemas ?? {})) checkSchema(schema, `/components/schemas/${esc(name)}`)
}
