import { readFileSync } from 'node:fs'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import { env } from './env'

// The orchestrator's OpenAPI document (saved by global setup to .auth/openapi.json) as an operation index for the
// generic API client and the authorization matrix, plus response-schema validation: 2xx JSON bodies are checked
// against the documented schema, so documentation drift fails tests (docs/testing.md §7.8).

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete']

export interface OpenApiParameter {
  name: string
  in: 'path' | 'query' | 'header' | 'cookie'
  required?: boolean
  schema?: Record<string, unknown>
}

export interface OpenApiOperation {
  operationId: string
  method: HttpMethod
  /** path template, for example /api/scans/{scanId} */
  path: string
  tags: string[]
  parameters: OpenApiParameter[]
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Record<string, unknown> }> }
  responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>
  /** the scantor extensions (x-scantor-scope, x-mcp, x-admin-only, x-read-only, x-destructive, x-session-only) */
  extensions: Record<string, unknown>
}

export interface OpenApiDocument {
  openapi: string
  paths: Record<string, Record<string, unknown>>
  components?: { schemas?: Record<string, unknown> }
  [key: string]: unknown
}

/** OpenAPI 3.0-style `nullable: true` becomes a type array, so the 2020-12 validator understands it. */
function convertNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convertNullable)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) out[key] = convertNullable(value)
  if (out.nullable === true) {
    delete out.nullable
    if (typeof out.type === 'string') out.type = [out.type, 'null']
    else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null']
  }
  return out
}

/** JSON pointer escaping of one path segment. */
const pointer = (segment: string) => segment.replaceAll('~', '~0').replaceAll('/', '~1')

const DOCUMENT_ID = 'scantor-openapi.json'

export class OpenApiIndex {
  readonly operations: ReadonlyMap<string, OpenApiOperation>
  private readonly ajv: Ajv2020
  private readonly validators = new Map<string, ValidateFunction | null>()

  constructor(readonly document: OpenApiDocument) {
    const operations = new Map<string, OpenApiOperation>()
    for (const [path, item] of Object.entries(document.paths)) {
      const shared = (item.parameters as OpenApiParameter[] | undefined) ?? []
      for (const method of METHODS) {
        const op = item[method] as Record<string, unknown> | undefined
        if (!op) continue
        const operationId = op.operationId as string | undefined
        if (!operationId) continue
        if (operations.has(operationId)) throw new Error(`duplicate operationId ${operationId} in the OpenAPI document`)
        operations.set(operationId, {
          operationId,
          method,
          path,
          tags: (op.tags as string[] | undefined) ?? [],
          parameters: [...shared, ...((op.parameters as OpenApiParameter[] | undefined) ?? [])],
          requestBody: op.requestBody as OpenApiOperation['requestBody'],
          responses: (op.responses as OpenApiOperation['responses'] | undefined) ?? {},
          extensions: Object.fromEntries(Object.entries(op).filter(([key]) => key.startsWith('x-'))),
        })
      }
    }
    this.operations = operations
    // The whole document is one schema resource, so `#/components/schemas/…` references resolve inside it.
    this.ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false })
    this.ajv.addSchema({ ...(convertNullable(document) as object), $id: DOCUMENT_ID })
  }

  static load(file = env.paths.openapi): OpenApiIndex {
    return new OpenApiIndex(JSON.parse(readFileSync(file, 'utf8')) as OpenApiDocument)
  }

  get(operationId: string): OpenApiOperation {
    const op = this.operations.get(operationId)
    if (!op) throw new Error(`unknown operationId ${operationId} (not in the OpenAPI document)`)
    return op
  }

  /** Validates a response body; returns the problems (empty when valid or when no JSON schema is documented). */
  validateResponse(operationId: string, status: number, body: unknown): string[] {
    const key = `${operationId} ${status}`
    let validate = this.validators.get(key)
    if (validate === undefined) {
      const op = this.get(operationId)
      const response = op.responses[String(status)] ? String(status) : op.responses[`${String(status)[0]}XX`] ? `${String(status)[0]}XX` : null
      const schema = response ? op.responses[response]?.content?.['application/json']?.schema : undefined
      validate = schema
        ? this.ajv.compile({
            $ref: `${DOCUMENT_ID}#/paths/${pointer(op.path)}/${op.method}/responses/${response}/content/${pointer('application/json')}/schema`,
          })
        : null
      this.validators.set(key, validate)
    }
    if (!validate || validate(body)) return []
    return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`)
  }
}
