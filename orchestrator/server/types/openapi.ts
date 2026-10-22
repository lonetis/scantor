import type { OperationScope } from '#shared/utils/enums'

/*
 * Route metadata of the OpenAPI document (docs/api.md §1.1). Every route file under server/api starts with
 *
 *   defineRouteMeta({ openAPI: { tags: ['scans'], operationId: 'pauseScan', summary, description,
 *     'x-scantor-scope': 'owner', 'x-mcp': true, parameters, requestBody, responses } })
 *
 * as a static object literal: Nitro reads it from the source at build time, so it may not reference imported
 * constants, spread values or computed keys. The types below are what scantor routes declare: a JSON Schema
 * 2020-12 subset with bounds (Nitro's own OpenAPI types omit `minLength`, `pattern`, `minProperties`, …) and the
 * x-scantor extensions, of which `x-scantor-scope` and `x-mcp` are required and `x-admin-only` is set iff the scope
 * is `admin`. shared/types/augments/route-meta.d.ts makes `defineRouteMeta` accept this shape. The runtime checks of
 * server/utils/operations.ts and tests/authz/openapi-lint.spec.ts enforce the same rules on the generated
 * document.
 *
 * Shared component schemas are declared once with `$global.components.schemas` in the anchor route of their tag and
 * referenced with `$ref`. The foundation declares the cross-tag building blocks in server/api/health.get.ts (`Error`,
 * `JobRef`, `ScantorError`, `BuildError`, `FileRef`, `ScanSettings`, `Description`, `Health`), `User` in
 * server/api/users/index.get.ts, `InstanceInfo` in server/api/info.get.ts and `SetupStatus` in
 * server/api/setup/status.get.ts.
 */

export type JsonSchemaTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

export interface JsonSchema {
  $ref?: string
  $comment?: string
  type?: JsonSchemaTypeName | JsonSchemaTypeName[]
  title?: string
  description?: string
  default?: unknown
  examples?: unknown[]
  example?: unknown
  enum?: unknown[]
  const?: unknown
  deprecated?: boolean
  readOnly?: boolean
  writeOnly?: boolean
  // strings
  format?: string
  pattern?: string
  minLength?: number
  maxLength?: number
  contentMediaType?: string
  contentEncoding?: string
  // numbers
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  // arrays
  items?: JsonSchema | boolean
  prefixItems?: JsonSchema[]
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  // objects
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  patternProperties?: Record<string, JsonSchema>
  propertyNames?: JsonSchema
  minProperties?: number
  maxProperties?: number
  // composition
  oneOf?: JsonSchema[]
  anyOf?: JsonSchema[]
  allOf?: JsonSchema[]
  not?: JsonSchema
  [extension: `x-${string}`]: unknown
}

export interface OpenApiMediaType {
  schema: JsonSchema
  example?: unknown
}

export interface OpenApiParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  description?: string
  deprecated?: boolean
  schema: JsonSchema
  example?: unknown
}

export interface OpenApiRequestBody {
  required?: boolean
  description?: string
  content: Record<string, OpenApiMediaType>
}

export interface OpenApiResponse {
  description: string
  headers?: Record<string, { description?: string; schema: JsonSchema }>
  content?: Record<string, OpenApiMediaType>
}

interface ScantorOperationBase {
  /** exactly one tag of docs/api.md §4 */
  tags: [string]
  /** camelCase, verb first, unique across the document */
  operationId: string
  summary: string
  /** written for an AI agent reader: what it does, when to use it, what it returns, common errors */
  description: string
  parameters?: OpenApiParameter[]
  requestBody?: OpenApiRequestBody
  responses: Record<string, OpenApiResponse>
  /** true = exposed as the MCP tool `snake_case(operationId)` */
  'x-mcp': boolean
  /** a non-GET operation without side effects (MCP read level) */
  'x-read-only'?: true
  /** only a browser session may call it (403 sessionRequired for API keys and MCP); scope owner or admin */
  'x-session-only'?: true
  /** a non-DELETE operation that discards work or data or revokes access (MCP destructiveHint) */
  'x-destructive'?: true
  $global?: { components: { schemas: Record<string, JsonSchema> } }
}

type AdminOperation = ScantorOperationBase & { 'x-scantor-scope': 'admin'; 'x-admin-only': true }
type NonAdminOperation = ScantorOperationBase & { 'x-scantor-scope': Exclude<OperationScope, 'admin'>; 'x-admin-only'?: never }

/** The `openAPI` object of a scantor route. */
export type ScantorOperation = AdminOperation | NonAdminOperation

export interface ScantorRouteMeta {
  openAPI: ScantorOperation
}
