import { fromJsonSchema, type JsonSchemaType, type StandardSchemaWithJSON, type ToolAnnotations } from '@modelcontextprotocol/server'
import { type McpOpenAPITool, OpenAPIToolGenerator, toSdkTool } from 'mcp-from-openapi'
import type { McpLevel } from '#shared/utils/enums'
import { loadOpenApiDocument, type OpenApiDocument } from '../../utils/operations'
import { UNTRUSTED_NOTE, UNTRUSTED_PATHS } from './untrusted'

// The MCP tool catalogue (docs/mcp.md §4.1, §4.2): generated once per process from the runtime OpenAPI document,
// opt-in by `x-mcp: true`, named `snake_case(operationId)`. Each tool records the level it needs (read for GET and
// x-read-only, admin for x-admin-only, write otherwise) and its annotations; `wait` is clamped to 50 s.

export const MCP_MAX_WAIT_SECONDS = 50
export const WAIT_DESCRIPTION = 'Seconds to wait for the resource to settle (0–50). Call again if it has not settled yet.'

export interface CatalogueTool {
  name: string
  operationId: string
  method: string
  path: string
  requirement: McpLevel
  tool: McpOpenAPITool
  config: {
    title?: string
    description: string
    inputSchema: StandardSchemaWithJSON
    annotations: ToolAnnotations
  }
}

export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

/** Annotation rules of docs/mcp.md §4.2. */
export function annotationsFor(method: string, operation: Record<string, unknown>, title: string | undefined): ToolAnnotations {
  const upper = method.toUpperCase()
  const readOnly = upper === 'GET' || operation['x-read-only'] === true
  return {
    ...(title ? { title } : {}),
    readOnlyHint: readOnly,
    destructiveHint: upper === 'DELETE' || upper === 'PUT' || operation['x-destructive'] === true,
    idempotentHint: upper === 'GET' || upper === 'PUT' || upper === 'DELETE' || operation['x-read-only'] === true,
    openWorldHint: false,
  }
}

export function requirementFor(method: string, operation: Record<string, unknown>): McpLevel {
  if (operation['x-admin-only'] === true) return 'admin'
  if (method.toUpperCase() === 'GET' || operation['x-read-only'] === true) return 'read'
  return 'write'
}

/** Clamps the advertised `wait` input to 50 s (in place). */
function patchWait(schema: Record<string, unknown>): void {
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
  const wait = properties?.wait
  if (!wait) return
  wait.maximum = MCP_MAX_WAIT_SECONDS
  wait.description = WAIT_DESCRIPTION
}

export async function generateCatalogue(spec: OpenApiDocument): Promise<CatalogueTool[]> {
  const generator = await OpenAPIToolGenerator.fromJSON(spec as never, { validate: false })
  const tools = await generator.generateTools({
    includePaths: ['/api/**'],
    filterFn: (operation: Record<string, unknown>) => operation['x-mcp'] === true,
    descriptionStrategy: 'combined',
    appendResponseSummary: true,
    includeAllResponses: false,
    target: 'strict',
    namingStrategy: { toolNameGenerator: (_path: string, _method: string, operationId?: string) => snakeCase(operationId ?? '') },
  } as never)
  return (tools as McpOpenAPITool[]).map((tool) => {
    const method = String(tool.metadata.method).toUpperCase()
    const operation = (spec.paths?.[tool.metadata.path]?.[String(tool.metadata.method).toLowerCase()] ?? {}) as Record<string, unknown>
    patchWait(tool.inputSchema as Record<string, unknown>)
    const operationId = String(operation.operationId ?? tool.metadata.operationId ?? tool.name)
    const [name, sdk] = toSdkTool(tool, { fromJsonSchema: (schema) => fromJsonSchema(schema as JsonSchemaType) })
    const description = UNTRUSTED_PATHS[operationId] ? `${sdk.description}\n\n${UNTRUSTED_NOTE}` : sdk.description
    return {
      name,
      operationId,
      method,
      path: tool.metadata.path,
      requirement: requirementFor(method, operation),
      tool,
      config: {
        ...(sdk.title ? { title: sdk.title } : {}),
        description,
        inputSchema: sdk.inputSchema,
        annotations: annotationsFor(method, operation, typeof operation.summary === 'string' ? operation.summary : sdk.title),
      },
    }
  })
}

let cataloguePromise: Promise<CatalogueTool[]> | null = null

/** The catalogue of this process; a failed build is not cached. */
export function loadCatalogue(): Promise<CatalogueTool[]> {
  cataloguePromise ??= loadOpenApiDocument()
    .then(generateCatalogue)
    .catch((error: unknown) => {
      cataloguePromise = null
      throw error
    })
  return cataloguePromise
}

const LEVEL_ORDER: Record<McpLevel, number> = { read: 0, write: 1, admin: 2 }

/** Tools a level may see and call (`read < write < admin`). */
export function toolsForLevel(catalogue: CatalogueTool[], level: McpLevel): CatalogueTool[] {
  return catalogue.filter((tool) => LEVEL_ORDER[tool.requirement] <= LEVEL_ORDER[level])
}
