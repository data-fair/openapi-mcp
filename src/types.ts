export type JsonSchema = Record<string, any>
export type Localized = string | Record<string, string>

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface AgentParamOverride {
  name?: string
  description?: Localized
  exclude?: boolean
  default?: unknown
  maximum?: number
  enum?: unknown[]
  required?: boolean
}

export interface AgentResponse {
  rows?: string
  concise?: string[]
  detailed?: true | string[]
  selectParam?: string
  hints?: boolean
}

export interface AgentOperation {
  profiles?: string[] | true
  name?: string
  title?: Localized
  description?: Localized
  examples?: Record<string, unknown>[]
  annotations?: ToolAnnotations
  params?: Record<string, AgentParamOverride>
  fixed?: Record<string, unknown>
  /**
   * How a JSON request body reaches the tool's input schema. 'flat' (the default) merges
   * its properties at top level. 'compact' exposes a single `body` property described by a
   * compact listing, and validates the real schema at execution — for bodies whose schema
   * is too large to put in a tool definition.
   */
  body?: 'flat' | 'compact'
  response?: AgentResponse
  editor?: true | { readOperation?: string }
}

export interface AgentSkill {
  name: string
  description: Localized
  profiles?: string[]
  tools?: string[]
}

export interface AgentRoot {
  namePrefix?: string
  profiles?: Record<string, { title?: Localized, description?: Localized }>
  skills?: AgentSkill[]
}

export interface AgentTag {
  profiles?: string[] | true
  skill?: Localized
}

export interface AgentProperty {
  hint?: Localized
  exclude?: boolean
}

export interface ResolvedParam {
  /** name in the HTTP API */
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
  schema: JsonSchema
  description?: string
  style?: string
  explode?: boolean
  agent: AgentParamOverride
}

export interface ResolvedOperation {
  operationId: string
  method: string
  path: string
  tags: string[]
  summary?: string
  description?: string
  params: ResolvedParam[]
  requestBody?: { schema: JsonSchema, required: boolean }
  /** JSON schema of the 2xx application/json response, if any */
  responseSchema?: JsonSchema
  /** media types declared for the 2xx response, in document order */
  responseMediaTypes: string[]
  agent: AgentOperation & { profiles: string[] | true }
  /** final tool name (prefix + name or snake_case operationId) */
  toolName: string
}

export interface ToolResult {
  text: string
  structuredContent?: unknown
  isError?: boolean
}

export interface Tool {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations: ToolAnnotations
  examples?: Record<string, unknown>[]
  execute (params: Record<string, unknown>): Promise<ToolResult>
}

export interface ToolSet {
  profile: string
  instructions: string
  tools: Tool[]
}
