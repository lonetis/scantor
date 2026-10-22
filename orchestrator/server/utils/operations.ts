import { OPERATION_SCOPES, type OperationScope } from '#shared/utils/enums'

// The operation registry (docs/auth.md §5.4): built once, lazily, from the runtime OpenAPI document (the same
// document the MCP bridge uses). The auth middleware resolves every `/api/*` request against it: a path without an
// operation is 404 (deny by default, so a route without OpenAPI metadata is unreachable), a matching path with
// another method is 405. Entries carry the scantor extensions of docs/api.md §1.1.

export const MAX_MCP_OPERATIONS = 30
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const

export interface Operation {
  method: string
  pathTemplate: string
  segments: string[]
  operationId: string
  tag: string | null
  scope: OperationScope
  mcp: boolean
  adminOnly: boolean
  readOnly: boolean
  sessionOnly: boolean
  destructive: boolean
  /** set when the operation violates the extension rules; such operations always answer 403 */
  problems: string[]
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, Record<string, unknown> | unknown>>
}

function isParam(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}')
}

/**
 * Splits a path into segments like Nitro's router: one trailing slash is ignored, but interior empty segments are
 * kept (and never match a template segment), so `/api//users` resolves to no operation instead of to `/api/users`.
 */
export function splitPath(path: string): string[] {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
  const segments = trimmed.split('/')
  return segments[0] === '' ? segments.slice(1) : segments
}

/** The prefix rule of docs/auth.md §5.4 for a path template. */
export function expectedScopeFor(pathTemplate: string, method: string): OperationScope[] {
  if (pathTemplate === '/api/health' || pathTemplate === '/api/docs' || pathTemplate === '/api/docs/openapi.json') return ['public']
  if (pathTemplate === '/api/setup/status' && method === 'GET') return ['public']
  if (pathTemplate.startsWith('/api/node/')) return ['node']
  if (pathTemplate === '/api/registry/token') return ['node']
  if (pathTemplate.startsWith('/api/runtime/')) return ['worker']
  if (pathTemplate.startsWith('/api/setup/')) return ['setup']
  if (pathTemplate === '/api/tools/forward-auth') return ['tools']
  return ['owner', 'admin']
}

/** Validation of one operation's extensions (docs/api.md §1.1, docs/auth.md §5.4). */
export function operationProblems(op: Omit<Operation, 'problems'>, raw: Record<string, unknown>): string[] {
  const problems: string[] = []
  if (!(OPERATION_SCOPES as readonly string[]).includes(String(raw['x-scantor-scope']))) problems.push('missing or invalid x-scantor-scope')
  if (typeof raw['x-mcp'] !== 'boolean') problems.push('missing x-mcp')
  if (op.adminOnly !== (op.scope === 'admin')) problems.push('x-admin-only must be true iff x-scantor-scope is admin')
  if (op.sessionOnly && op.scope !== 'owner' && op.scope !== 'admin') problems.push('x-session-only requires scope owner or admin')
  if (op.destructive && op.method === 'DELETE') problems.push('x-destructive must not be set on a DELETE')
  if (!/^[a-z]+[A-Za-z0-9]*$/.test(op.operationId)) problems.push('operationId must be camelCase')
  if (!expectedScopeFor(op.pathTemplate, op.method).includes(op.scope)) {
    problems.push(`scope ${op.scope} does not match the route prefix (${expectedScopeFor(op.pathTemplate, op.method).join(' or ')})`)
  }
  return problems
}

export interface OperationRegistry {
  operations: Operation[]
  /** document-level problems (duplicate operationIds, too many MCP tools) */
  problems: string[]
}

/** Builds the registry from an OpenAPI document. Operations without operationId are ignored (deny by default). */
export function buildOperationRegistry(document: OpenApiDocument): OperationRegistry {
  const operations: Operation[] = []
  const seen = new Map<string, number>()
  for (const [pathTemplate, item] of Object.entries(document.paths ?? {})) {
    if (!pathTemplate.startsWith('/api/') || !item || typeof item !== 'object') continue
    for (const method of HTTP_METHODS) {
      const raw = (item as Record<string, unknown>)[method] as Record<string, unknown> | undefined
      if (!raw || typeof raw.operationId !== 'string') continue
      const tags = Array.isArray(raw.tags) ? (raw.tags as unknown[]).filter((tag) => typeof tag === 'string') : []
      const base: Omit<Operation, 'problems'> = {
        method: method.toUpperCase(),
        pathTemplate,
        segments: splitPath(pathTemplate),
        operationId: raw.operationId,
        tag: (tags[0] as string | undefined) ?? null,
        scope: ((OPERATION_SCOPES as readonly string[]).includes(String(raw['x-scantor-scope'])) ? raw['x-scantor-scope'] : 'admin') as OperationScope,
        mcp: raw['x-mcp'] === true,
        adminOnly: raw['x-admin-only'] === true,
        readOnly: raw['x-read-only'] === true,
        sessionOnly: raw['x-session-only'] === true,
        destructive: raw['x-destructive'] === true,
      }
      seen.set(base.operationId, (seen.get(base.operationId) ?? 0) + 1)
      operations.push({ ...base, problems: operationProblems(base, raw) })
    }
  }
  const problems: string[] = []
  for (const [operationId, count] of seen) if (count > 1) problems.push(`operationId ${operationId} is used ${count} times`)
  for (const op of operations) if ((seen.get(op.operationId) ?? 0) > 1) op.problems.push('duplicate operationId')
  const mcpCount = operations.filter((op) => op.mcp).length
  if (mcpCount > MAX_MCP_OPERATIONS) problems.push(`${mcpCount} operations have x-mcp: true (maximum ${MAX_MCP_OPERATIONS})`)
  return { operations, problems }
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** True when `template` matches `segments` (static segments exactly, `{param}` one non-empty segment). */
function templateMatches(template: string[], segments: string[]): boolean {
  if (template.length !== segments.length) return false
  return template.every((part, index) => segments[index] !== '' && (isParam(part) || part === segments[index]))
}

/** Orders candidate templates like Nitro's router: a static segment wins at the first position where they differ. */
function compareSpecificity(a: string[], b: string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const aParam = isParam(a[index]!)
    const bParam = isParam(b[index]!)
    if (aParam !== bParam) return aParam ? 1 : -1
  }
  return 0
}

export type OperationMatch =
  | { kind: 'match'; operation: Operation; params: Record<string, string> }
  | { kind: 'methodNotAllowed'; allowed: string[] }
  | { kind: 'notFound' }

/** Resolves a request against the registry. HEAD is matched as GET. */
export function matchOperation(registry: OperationRegistry, method: string, pathname: string): OperationMatch {
  const segments = splitPath(pathname)
  const candidates = registry.operations.filter((op) => templateMatches(op.segments, segments))
  if (candidates.length === 0) return { kind: 'notFound' }
  // The most specific template decides which operations share the path; methods are compared among those.
  const best = [...candidates].sort((a, b) => compareSpecificity(a.segments, b.segments))[0]!
  const sameTemplate = candidates.filter((op) => op.pathTemplate === best.pathTemplate)
  const wanted = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  const operation = sameTemplate.find((op) => op.method === wanted)
  if (!operation) return { kind: 'methodNotAllowed', allowed: sameTemplate.map((op) => op.method) }
  const params: Record<string, string> = {}
  for (const [index, part] of operation.segments.entries()) {
    if (!isParam(part)) continue
    const decoded = safeDecode(segments[index]!)
    // A malformed percent-encoding names no resource.
    if (decoded === null) return { kind: 'notFound' }
    params[part.slice(1, -1)] = decoded
  }
  return { kind: 'match', operation, params }
}

// ── process registry ────────────────────────────────────────────────────────

export type OpenApiDocumentLoader = () => Promise<OpenApiDocument>

let loader: OpenApiDocumentLoader | null = null
let registryPromise: Promise<OperationRegistry> | null = null

/** Sets how the runtime OpenAPI document is loaded (server/plugins/00.boot.ts uses Nitro's localFetch). */
export function setOpenApiDocumentLoader(load: OpenApiDocumentLoader): void {
  loader = load
  registryPromise = null
}

/** Loads the runtime OpenAPI document (shared by the registry and the MCP tool catalogue). */
export function loadOpenApiDocument(): Promise<OpenApiDocument> {
  if (!loader) return Promise.reject(new Error('the OpenAPI document loader is not configured'))
  return loader()
}

/** The registry of this process, built on first use; a failed build is not cached. */
export function useOperationRegistry(): Promise<OperationRegistry> {
  registryPromise ??= loadOpenApiDocument()
    .then(buildOperationRegistry)
    .catch((error: unknown) => {
      registryPromise = null
      throw error
    })
  return registryPromise
}
