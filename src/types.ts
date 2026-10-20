export type JsonSchema = Record<string, any>
export type Localized = string | Record<string, string>

export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** An OpenAPI security requirement: scheme name → scopes. `{}` is the public alternative. */
export type SecurityRequirement = Record<string, string[]>

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
  /** JSON pointer to a list of strings the API returns as advice: shown as hints after the rest */
  hints?: string
  /**
   * The response is a file: the tool performs no request and returns a link to it (an MCP
   * `resource_link`) built from its arguments. GET only; excludes every rendering key.
   */
  file?: true
}

export interface AgentOperation {
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
  /**
   * Allow-list of request body properties this tool offers. The body schema is pruned to them
   * before `body` mode applies, and extra properties are refused: a field added to the API
   * later is exposed nowhere until an annotation places it.
   */
  bodyFields?: string[]
  /**
   * Body properties this tool requires, on top of those the schema requires. Each must be one
   * the tool offers (in `bodyFields` when present). For an operation serving several purposes
   * through one body, where the tool is about one of them: a required file part also makes the
   * tool unavailable when no file store is configured.
   */
  bodyRequired?: string[]
  response?: AgentResponse
  editor?: true | AgentEditor
  /**
   * The tool's security, narrowing the operation's: each alternative must be one the
   * operation (or the document root) declares. For a view whose purpose needs more than
   * the operation's weakest alternative, so a token that cannot use it is not offered it.
   */
  security?: SecurityRequirement[]
}

/**
 * An operation's `x-agent`: one tool, or several views of the operation, each its own tool —
 * a PATCH whose fields serve different purposes is offered as one tool per purpose.
 */
export type AgentOperationAnnotation = AgentOperation | AgentOperation[]

/** Names the operations a json-layout editor group reads its schema and document from. */
export interface AgentEditor {
  /** operationId whose response body IS the request body's JSON Schema; absent means the declared one */
  schemaOperation?: string
  /** fixed parameter values for that operation */
  schemaParams?: Record<string, unknown>
  /** operationId that loads the document being edited; absent means a create */
  readOperation?: string
}

/**
 * A skill in the Agent Skills sense: `description` is what an agent reads to decide whether the
 * skill applies (always shown, at most 1024 characters); the body is read on demand, inline in
 * `body` or linked by `href` (relative to the document's URL). Neither: the description is the body.
 */
export interface AgentSkill {
  name: string
  description: Localized
  href?: Localized
  body?: Localized
  tools?: string[]
}

export interface AgentRoot {
  skills?: AgentSkill[]
}

export interface AgentTag {
  guide?: Localized
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

/**
 * The request body a tool sends, chosen among those an operation declares: `application/json`
 * first, then `multipart/form-data`, then a raw body that is the bytes of one file (`text/csv`,
 * ndjson…). A JSON tool therefore stays what it was when an operation also accepts uploads.
 */
export interface ResolvedBody {
  kind: 'json' | 'multipart' | 'file'
  /** the declared schema; `{}` for a raw file body */
  schema: JsonSchema
  required: boolean
  /** multipart: the media types a part declares in `encoding.<part>.contentType` (a comma-separated list) */
  encoding?: Record<string, string[]>
  /** file: the raw media types the operation declares, in document order */
  mediaTypes?: string[]
}

export interface ResolvedOperation {
  operationId: string
  method: string
  path: string
  tags: string[]
  summary?: string
  description?: string
  params: ResolvedParam[]
  requestBody?: ResolvedBody
  /** JSON schema of the 2xx application/json response, if any */
  responseSchema?: JsonSchema
  /** media types declared for the 2xx response, in document order */
  responseMediaTypes: string[]
  agent: AgentOperation
  /** final tool name (x-agent name, else snake_case operationId) */
  toolName: string
  /** effective security: the x-agent entry's, else the operation's, else the document's; absent when none declares one */
  security?: SecurityRequirement[]
}

/** An MCP `resource_link`: a file the client fetches itself (MCP 2026-07-28, tool results). */
export interface ResourceLink {
  uri: string
  name: string
  mimeType?: string
}

export interface ToolResult {
  text: string
  structuredContent?: unknown
  isError?: boolean
  /** a file returned by reference (`response.file`); `text` then describes it */
  resourceLink?: ResourceLink
}

/**
 * What a single call carries. The library never produces one: a server derives it from
 * the request it is serving (cookies, an API key, a caller key); on stdio there is none and
 * identity is the environment.
 */
export interface CallContext {
  /** wins over the load-time fetch for this call */
  fetch?: typeof fetch
  /** merged into the upstream request; overrides a header already present */
  headers?: Record<string, string>
  signal?: AbortSignal
  /** opaque caller key partitioning stateful tool groups (editor sessions) */
  identity?: string
}

export interface Tool {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  annotations: ToolAnnotations
  examples?: Record<string, unknown>[]
  /** the security of the operation behind the tool (see ResolvedOperation.security) */
  security?: SecurityRequirement[]
  execute (params: Record<string, unknown>, ctx?: CallContext): Promise<ToolResult>
}

/** A resolved skill, served as the `skill://<name>/SKILL.md` resource and listed in the instructions. */
export interface Skill {
  name: string
  /** what the skill is for and when to use it — the SKILL.md frontmatter description */
  description: string
  /** the markdown body, plus a `Tools:` line when the skill lists tools; empty when `error` is set */
  body: string
  /** `sha256:` over `body` */
  digest: string
  /** why a linked body could not be read; the skill stays listed and its resource read reports it */
  error?: string
  tools?: string[]
}

/** Reads a linked skill body; never throws. */
export type SkillBodyFetcher = (url: string) => Promise<{ text: string } | { error: string }>

/** A tag's `x-agent.guide`: a section of the instructions, kept while one of its tools is. */
export interface Guide {
  /** the tag's name */
  name: string
  text: string
  tools: string[]
}

export interface ToolSet {
  tools: Tool[]
  skills: Skill[]
  guides: Guide[]
}
