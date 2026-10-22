import { describe, expect, it } from 'vitest'
import {
  buildOperationRegistry,
  expectedScopeFor,
  matchOperation,
  type OpenApiDocument,
  publishedOpenApiDocument,
} from '../../server/utils/operations'

function op(operationId: string, scope: string, extra: Record<string, unknown> = {}) {
  return { operationId, tags: ['t'], 'x-scantor-scope': scope, 'x-mcp': false, ...extra }
}

const document: OpenApiDocument = {
  paths: {
    '/api/health': { get: op('getHealth', 'public') },
    '/api/tasks': { get: op('listTasks', 'owner', { 'x-mcp': true }), post: op('createTask', 'owner', { 'x-mcp': true }) },
    '/api/tasks/upload': { post: op('uploadTask', 'owner') },
    '/api/tasks/{task}': { get: op('getTask', 'owner'), delete: op('deleteTask', 'owner') },
    '/api/tasks/{task}/files': { get: op('listTaskFiles', 'owner') },
    '/api/users': { get: op('listUsers', 'admin', { 'x-admin-only': true }) },
    '/api/scans/{scanId}/cancel': { post: op('cancelScan', 'owner', { 'x-destructive': true }) },
    '/api/node/hello': { post: op('nodeHello', 'node') },
    '/api/runtime/state': { post: op('runtimeState', 'worker') },
    '/api/setup/status': { get: op('getSetupStatus', 'public') },
    '/api/setup/admin': { post: op('createSetupAdmin', 'setup') },
    '/api/tools/forward-auth': { get: op('toolsForwardAuth', 'tools') },
    '/api/registry/token': { get: op('getRegistryToken', 'node'), post: op('postRegistryToken', 'node') },
    '/api/account/api-keys': { post: op('createApiKey', 'owner', { 'x-session-only': true }) },
    '/api/auth/{path}': { get: {} },
    '/mcp': { post: op('mcp', 'owner') },
    '/api/no-meta': { get: { summary: 'no operationId' } },
  },
}

describe('buildOperationRegistry', () => {
  const registry = buildOperationRegistry(document)

  it('collects every /api operation with an operationId and its extensions', () => {
    const ids = registry.operations.map((operation) => operation.operationId)
    expect(ids).toContain('getHealth')
    expect(ids).not.toContain('mcp')
    expect(registry.operations.find((operation) => operation.operationId === 'cancelScan')).toMatchObject({
      method: 'POST',
      pathTemplate: '/api/scans/{scanId}/cancel',
      scope: 'owner',
      destructive: true,
      problems: [],
    })
    expect(registry.operations.find((operation) => operation.operationId === 'listTasks')?.mcp).toBe(true)
    expect(registry.problems).toEqual([])
  })

  it('accepts the documented scope of every prefix', () => {
    for (const operation of registry.operations) expect(operation.problems, operation.operationId).toEqual([])
  })

  it('flags extension rule violations', () => {
    const broken = buildOperationRegistry({
      paths: {
        '/api/a': { get: { operationId: 'getA', 'x-scantor-scope': 'owner' } },
        '/api/b': { get: op('getB', 'admin') },
        '/api/c': { get: op('getC', 'owner', { 'x-admin-only': true }) },
        '/api/d': { delete: op('deleteD', 'owner', { 'x-destructive': true }) },
        '/api/node/e': { get: op('getE', 'owner') },
        '/api/f': { get: op('getF', 'node') },
        '/api/g': { get: op('GetG', 'owner') },
        '/api/h': { get: op('getH', 'public', { 'x-session-only': true }) },
        '/api/i': { get: { operationId: 'getI', 'x-mcp': false } },
      },
    })
    const problems = Object.fromEntries(broken.operations.map((operation) => [operation.operationId, operation.problems]))
    expect(problems.getA).toEqual(['missing x-mcp'])
    expect(problems.getB).toEqual(['x-admin-only must be true iff x-scantor-scope is admin'])
    expect(problems.getC).toEqual(['x-admin-only must be true iff x-scantor-scope is admin'])
    expect(problems.deleteD).toEqual(['x-destructive must not be set on a DELETE'])
    expect(problems.getE?.[0]).toMatch(/does not match the route prefix/)
    expect(problems.getF?.[0]).toMatch(/does not match the route prefix/)
    expect(problems.GetG).toEqual(['operationId must be camelCase'])
    expect(problems.getH?.[0]).toMatch(/x-session-only requires scope owner or admin/)
    expect(problems.getI?.[0]).toBe('missing or invalid x-scantor-scope')
  })

  it('reports duplicate operationIds and more than 30 MCP operations', () => {
    const paths: OpenApiDocument['paths'] = { '/api/x': { get: op('getX', 'owner'), post: op('getX', 'owner') } }
    for (let index = 0; index < 31; index++) paths![`/api/m${index}`] = { get: op(`getM${index}`, 'owner', { 'x-mcp': true }) }
    const result = buildOperationRegistry({ paths })
    expect(result.problems).toContain('operationId getX is used 2 times')
    expect(result.problems).toContain('31 operations have x-mcp: true (maximum 30)')
    expect(result.operations.filter((operation) => operation.operationId === 'getX').every((operation) => operation.problems.includes('duplicate operationId'))).toBe(
      true,
    )
  })
})

describe('matchOperation', () => {
  const registry = buildOperationRegistry(document)

  it('matches static segments before parameters (Nitro precedence)', () => {
    const upload = matchOperation(registry, 'POST', '/api/tasks/upload')
    expect(upload.kind === 'match' && upload.operation.operationId).toBe('uploadTask')
    const task = matchOperation(registry, 'GET', '/api/tasks/echo')
    expect(task.kind === 'match' && task.operation.operationId).toBe('getTask')
    expect(task.kind === 'match' && task.params).toEqual({ task: 'echo' })
  })

  it('answers 405 with the allowed methods of the most specific template', () => {
    const result = matchOperation(registry, 'PUT', '/api/tasks/upload')
    expect(result).toEqual({ kind: 'methodNotAllowed', allowed: ['POST'] })
    expect(matchOperation(registry, 'PATCH', '/api/tasks/echo')).toEqual({ kind: 'methodNotAllowed', allowed: ['GET', 'DELETE'] })
  })

  it('denies paths without an operation', () => {
    expect(matchOperation(registry, 'GET', '/api/no-meta')).toEqual({ kind: 'notFound' })
    expect(matchOperation(registry, 'GET', '/api/tasks/a/b/c')).toEqual({ kind: 'notFound' })
    expect(matchOperation(registry, 'GET', '/api/unknown')).toEqual({ kind: 'notFound' })
  })

  it('matches HEAD as GET', () => {
    const result = matchOperation(registry, 'HEAD', '/api/health')
    expect(result.kind === 'match' && result.operation.operationId).toBe('getHealth')
  })

  it('decodes parameters and treats malformed encodings as not found', () => {
    const encoded = matchOperation(registry, 'GET', '/api/tasks/a%20b')
    expect(encoded.kind === 'match' && encoded.params.task).toBe('a b')
    expect(matchOperation(registry, 'GET', '/api/tasks/%E0%A4%A')).toEqual({ kind: 'notFound' })
  })

  it('never lets an empty segment match, but ignores one trailing slash (like Nitro)', () => {
    expect(matchOperation(registry, 'GET', '/api/tasks//files')).toEqual({ kind: 'notFound' })
    expect(matchOperation(registry, 'GET', '/api//tasks')).toEqual({ kind: 'notFound' })
    expect(matchOperation(registry, 'GET', '/api/tasks//')).toEqual({ kind: 'notFound' })
    const trailing = matchOperation(registry, 'GET', '/api/tasks/')
    expect(trailing.kind === 'match' && trailing.operation.operationId).toBe('listTasks')
  })
})

describe('expectedScopeFor', () => {
  it.each([
    ['/api/health', 'GET', ['public']],
    ['/api/setup/status', 'GET', ['public']],
    ['/api/setup/admin', 'POST', ['setup']],
    ['/api/node/status', 'POST', ['node']],
    ['/api/registry/token', 'GET', ['node']],
    ['/api/runtime/bootstrap', 'GET', ['worker']],
    ['/api/tools/forward-auth', 'GET', ['tools']],
    ['/api/tools/session', 'GET', ['owner', 'admin']],
    ['/api/scans', 'GET', ['owner', 'admin']],
  ])('%s %s → %j', (path, method, scopes) => {
    expect(expectedScopeFor(path, method)).toEqual(scopes)
  })
})

describe('publishedOpenApiDocument', () => {
  const generated = {
    openapi: '3.1.0',
    info: { title: 'scantor API', version: 'dev' },
    paths: {
      '': { get: { tags: ['App Routes'], responses: {} } },
      '/api/auth/{all}': { get: { tags: ['API Routes'], responses: {} } },
      '/api/docs/openapi.json': { get: { tags: ['API Routes'], responses: {} } },
      '/api/tasks': {
        parameters: [],
        get: op('listTasks', 'owner'),
        post: { tags: ['API Routes'], responses: {} },
      },
      '/api/tasks/{task}': { get: op('getTask', 'owner') },
    },
    components: { schemas: { Error: { type: 'object' } } },
  }

  it('keeps only operations with an operationId and drops path items left without one', () => {
    const published = publishedOpenApiDocument(generated)
    expect(Object.keys(published.paths ?? {})).toEqual(['/api/tasks', '/api/tasks/{task}'])
    expect(published.paths?.['/api/tasks']).toEqual({ parameters: [], get: op('listTasks', 'owner') })
  })

  it('keeps the rest of the document and does not modify its input', () => {
    const published = publishedOpenApiDocument(generated)
    expect(published.openapi).toBe('3.1.0')
    expect(published.components).toBe(generated.components)
    expect(Object.keys(generated.paths)).toHaveLength(5)
    expect(generated.paths['/api/tasks']).toHaveProperty('post')
  })
})
