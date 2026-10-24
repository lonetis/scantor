import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { OpenApiDocument } from '../helpers/openapi'
import { expect, test } from '../fixtures'

// The OpenAPI lint (docs/testing.md §8.5, docs/security.md §7, docs/api.md §1.1, docs/auth.md §5.4): every operation of
// the live document carries the scantor extensions consistently, its scope matches its route prefix, and every route
// file of the orchestrator is an operation of the document (deny by default makes a route without metadata
// unreachable, so a missing operation is a broken route). Complements the generated matrix in matrix.spec.ts.

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const
const SCOPES = ['owner', 'admin', 'public', 'node', 'worker', 'setup', 'tools']
const MAX_MCP_OPERATIONS = 30

/** Verbs an operationId may start with (docs/api.md §1.1: `list…`, `get…`, `create…`, … ). */
const VERBS = new Set([
  'list',
  'get',
  'create',
  'update',
  'delete',
  'start',
  'pause',
  'resume',
  'cancel',
  'retry',
  'restart',
  'scale',
  'stop',
  'export',
  'query',
  'aggregate',
  'read',
  'write',
  'upload',
  'download',
  'import',
  'pull',
  'publish',
  'test',
  'stream',
  'estimate',
  'set',
  'remove',
  'rotate',
  'revoke',
  'ban',
  'unban',
  'post',
])

/**
 * The machine APIs keep the operationIds their route tables document (docs/api.md §4.18, §7, §8): a namespace of the
 * machine protocol first (`nodeHello`, `runtimeBootstrap`, `schedulerDone`, `toolsForwardAuth`). Allowed only on the
 * machine scopes.
 */
const MACHINE_NAMESPACES: Record<string, string[]> = { node: ['node'], worker: ['runtime', 'scheduler'], tools: ['tools'] }

/** The operations docs/api.md §1.1 marks `x-session-only` and `x-destructive`. */
const SESSION_ONLY = ['createApiKey', 'createToolsSession', 'removeAccountPassword', 'setAccountPassword']
const DESTRUCTIVE = ['banUser', 'cancelScan', 'cancelTestRun', 'rotateNodeToken']

interface RawOperation {
  operationId: string
  method: string
  path: string
  op: Record<string, unknown>
}

function operationsOf(document: OpenApiDocument): RawOperation[] {
  const out: RawOperation[] = []
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined
      if (op) out.push({ operationId: String(op.operationId ?? ''), method: method.toUpperCase(), path, op })
    }
  }
  return out
}

/** The prefix rule of docs/auth.md §5.4: the scopes an operation at this path may have. */
function scopesForPath(path: string, method: string): string[] {
  if (path === '/api/health' || path === '/api/docs' || path === '/api/docs/openapi.json') return ['public']
  if (path === '/api/setup/status' && method === 'GET') return ['public']
  if (path.startsWith('/api/node/') || path === '/api/registry/token') return ['node']
  if (path.startsWith('/api/runtime/')) return ['worker']
  if (path.startsWith('/api/setup/')) return ['setup']
  if (path === '/api/tools/forward-auth') return ['tools']
  return ['owner', 'admin']
}

/** Route files of the orchestrator: `server/api/scans/[scanId]/pause.post.ts` → POST /api/scans/{scanId}/pause. */
function routeFiles(apiDir: string): { file: string; method: string; path: string; source: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    )
  return walk(apiDir).map((file) => {
    const parts = relative(apiDir, file).split(sep)
    const last = parts.pop()!.replace(/\.ts$/, '')
    const match = /^(.*)\.(get|put|post|delete|patch)$/.exec(last)
    const segments = [...parts, match ? match[1]! : last].filter((segment) => segment !== 'index').map((segment) => segment.replace(/^\[(.+)\]$/, '{$1}'))
    return {
      file: relative(apiDir, file),
      method: match ? match[2]!.toUpperCase() : '',
      path: `/api/${segments.join('/')}`,
      source: readFileSync(file, 'utf8'),
    }
  })
}

test.describe('OpenAPI lint', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  let document: OpenApiDocument
  let operations: RawOperation[]

  test.beforeEach(async ({ anonApi }) => {
    const response = await anonApi.request.get('/api/docs/openapi.json')
    expect(response.status()).toBe(200)
    document = (await response.json()) as OpenApiDocument
    operations = operationsOf(document)
    expect(operations.length, 'the document lists operations').toBeGreaterThan(50)
  })

  test('every operation has exactly one tag, a summary and a description', { tag: ['@OAS-002'] }, () => {
    for (const { operationId, op } of operations) {
      expect.soft(op.tags, `${operationId} tags`).toEqual([expect.any(String)])
      expect.soft(typeof op.summary === 'string' && op.summary.trim().length > 0, `${operationId} has a summary`).toBe(true)
      expect.soft(typeof op.description === 'string' && op.description.trim().length > 0, `${operationId} has a description`).toBe(true)
    }
    const tags = new Set(operations.flatMap(({ op }) => (op.tags as string[] | undefined) ?? []))
    const declared = new Set(((document.tags as { name: string }[] | undefined) ?? []).map((tag) => tag.name))
    if (declared.size > 0) for (const tag of tags) expect.soft(declared.has(tag), `tag ${tag} is declared at the document level`).toBe(true)
  })

  test('operationIds are unique, camelCase and verb-first', { tag: ['@OAS-002'] }, () => {
    const counts = new Map<string, number>()
    for (const { operationId } of operations) counts.set(operationId, (counts.get(operationId) ?? 0) + 1)
    expect(
      [...counts].filter(([, n]) => n > 1).map(([id]) => id),
      'duplicate operationIds',
    ).toEqual([])
    for (const { operationId, op } of operations) {
      expect.soft(operationId, 'camelCase').toMatch(/^[a-z]+(?:[A-Z][a-z0-9]*)*$/)
      const first = /^[a-z]+/.exec(operationId)?.[0] ?? ''
      const scope = String(op['x-scantor-scope'])
      const allowed = VERBS.has(first) || (MACHINE_NAMESPACES[scope] ?? []).includes(first)
      expect.soft(allowed, `${operationId} starts with a verb (or its machine namespace), not "${first}"`).toBe(true)
    }
  })

  test('every operation declares x-scantor-scope and x-mcp', { tag: ['@OAS-002'] }, () => {
    for (const { operationId, op } of operations) {
      expect.soft(SCOPES, `${operationId} x-scantor-scope`).toContain(op['x-scantor-scope'])
      expect.soft(typeof op['x-mcp'], `${operationId} x-mcp`).toBe('boolean')
    }
  })

  test('x-admin-only is set exactly when the scope is admin', { tag: ['@OAS-002'] }, () => {
    for (const { operationId, op } of operations) {
      const adminOnly = op['x-admin-only'] === true
      expect
        .soft(adminOnly, `${operationId}: x-admin-only ${String(op['x-admin-only'])} with scope ${String(op['x-scantor-scope'])}`)
        .toBe(op['x-scantor-scope'] === 'admin')
      if ('x-admin-only' in op) expect.soft(op['x-admin-only'], `${operationId}: x-admin-only is only ever true`).toBe(true)
    }
  })

  test('x-session-only appears only with scope owner or admin, on the documented operations', { tag: ['@OAS-002'] }, () => {
    const sessionOnly = operations.filter(({ op }) => op['x-session-only'] === true)
    for (const { operationId, op } of sessionOnly) expect.soft(['owner', 'admin'], `${operationId} scope`).toContain(op['x-scantor-scope'])
    expect(sessionOnly.map(({ operationId }) => operationId).sort()).toEqual(SESSION_ONLY)
  })

  test('x-destructive never appears on a DELETE and marks the documented operations', { tag: ['@OAS-002'] }, () => {
    const destructive = operations.filter(({ op }) => op['x-destructive'] === true)
    for (const { operationId, method } of destructive) expect.soft(method, `${operationId} is not a DELETE`).not.toBe('DELETE')
    expect(destructive.map(({ operationId }) => operationId).sort()).toEqual(DESTRUCTIVE)
    for (const { operationId, method, op } of operations) {
      if (op['x-read-only'] === true) expect.soft(method, `${operationId}: x-read-only marks a non-GET operation`).not.toBe('GET')
    }
  })

  test('at most 30 operations are MCP tools', { tag: ['@OAS-002'] }, () => {
    const tools = operations.filter(({ op }) => op['x-mcp'] === true)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.length).toBeLessThanOrEqual(MAX_MCP_OPERATIONS)
  })

  test('every request body has a schema', { tag: ['@OAS-002'] }, () => {
    for (const { operationId, op } of operations) {
      const body = op.requestBody as { content?: Record<string, { schema?: unknown }> } | undefined
      if (!body) continue
      const content = Object.entries(body.content ?? {})
      expect.soft(content.length, `${operationId} request body has a media type`).toBeGreaterThan(0)
      for (const [type, media] of content) expect.soft(media.schema, `${operationId} ${type} schema`).toBeTruthy()
    }
  })

  test('no route file lacks OpenAPI metadata', { tag: ['@OAS-002'] }, ({ env }) => {
    const files = routeFiles(join(env.paths.repo, 'orchestrator', 'server', 'api'))
    // The better-auth catch-all is served outside the document on purpose (docs/api.md §3).
    const routes = files.filter((route) => route.file !== join('auth', '[...all].ts'))
    expect(files.length - routes.length, 'the better-auth catch-all exists').toBe(1)
    const byRoute = new Map(operations.map((op) => [`${op.method} ${op.path}`, op]))
    for (const route of routes) {
      const declared = /\boperationId:\s*['"]([A-Za-z0-9]+)['"]/.exec(route.source)?.[1]
      expect
        .soft(route.source.trimStart().startsWith('defineRouteMeta') || /^\s*defineRouteMeta\(/m.test(route.source), `${route.file} declares route meta`)
        .toBe(true)
      expect.soft(declared, `${route.file} declares an operationId`).toBeTruthy()
      const op = byRoute.get(`${route.method} ${route.path}`)
      expect.soft(op?.operationId, `${route.file} is the operation ${route.method} ${route.path} of the document`).toBe(declared)
    }
    // And the other way round: every operation of the document has its route file.
    const fileRoutes = new Set(routes.map((route) => `${route.method} ${route.path}`))
    for (const { operationId, method, path } of operations) expect.soft(fileRoutes.has(`${method} ${path}`), `${operationId} has a route file`).toBe(true)
  })

  test("each operation's scope matches its route prefix", { tag: ['@OAS-003'] }, () => {
    const seen = new Set<string>()
    for (const { operationId, method, path, op } of operations) {
      const allowed = scopesForPath(path, method)
      seen.add(allowed.join('|'))
      expect.soft(allowed, `${operationId} (${method} ${path}) has scope ${String(op['x-scantor-scope'])}`).toContain(op['x-scantor-scope'])
    }
    // The document exercises every prefix rule, so the check above is not vacuous.
    expect([...seen].sort()).toEqual(['node', 'owner|admin', 'public', 'setup', 'tools', 'worker'])
    const byId = new Map(operations.map((o) => [o.operationId, o.op['x-scantor-scope']]))
    expect(byId.get('getSetupStatus'), 'the setup status is public').toBe('public')
    expect(byId.get('getHealth')).toBe('public')
    expect(byId.get('getRegistryToken')).toBe('node')
    expect(byId.get('createRegistryToken')).toBe('node')
    expect(byId.get('toolsForwardAuth')).toBe('tools')
  })
})
