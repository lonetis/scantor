import { describe, expect, it } from 'vitest'
import { annotationsFor, generateCatalogue, MCP_MAX_WAIT_SECONDS, requirementFor, snakeCase, toolsForLevel } from '../../../server/services/mcp/tools'
import { UNTRUSTED_NOTE } from '../../../server/services/mcp/untrusted'

// Tool generation from the OpenAPI document (docs/mcp.md §4.1, §4.2) through the real mcp-from-openapi generator.

const errorRef = { description: 'error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }

const spec = {
  openapi: '3.1.0',
  info: { title: 'scantor API', version: 'test' },
  components: {
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'object' } } },
      Scan: { type: 'object', properties: { id: { type: 'string' }, state: { type: 'string' } } },
    },
  },
  paths: {
    '/api/scans/{scanId}': {
      get: {
        tags: ['scans'],
        operationId: 'getScan',
        summary: 'Get a scan',
        description: 'Returns one scan.',
        'x-scantor-scope': 'owner',
        'x-mcp': true,
        parameters: [
          { name: 'scanId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'wait', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 120 } },
        ],
        responses: { 200: { description: 'scan', content: { 'application/json': { schema: { $ref: '#/components/schemas/Scan' } } } }, 404: errorRef },
      },
      delete: {
        tags: ['scans'],
        operationId: 'deleteScan',
        summary: 'Delete a scan',
        description: 'Deletes a scan.',
        'x-scantor-scope': 'owner',
        'x-mcp': true,
        parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 202: { description: 'accepted' } },
      },
    },
    '/api/scans/{scanId}/cancel': {
      post: {
        tags: ['scans'],
        operationId: 'cancelScan',
        summary: 'Cancel a scan',
        description: 'Cancels a scan.',
        'x-scantor-scope': 'owner',
        'x-mcp': true,
        'x-destructive': true,
        parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'scan' } },
      },
    },
    '/api/scans/{scanId}/analyses/query': {
      post: {
        tags: ['analyses'],
        operationId: 'queryAnalyses',
        summary: 'Query analyses',
        description: 'Runs a filter.',
        'x-scantor-scope': 'owner',
        'x-mcp': true,
        'x-read-only': true,
        parameters: [{ name: 'scanId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties: { filter: { type: 'object' }, limit: { type: 'integer', maximum: 1000 } }, required: ['filter'] } } },
        },
        responses: { 200: { description: 'items' } },
      },
    },
    '/api/nodes': {
      get: {
        tags: ['nodes'],
        operationId: 'listNodes',
        summary: 'List nodes',
        description: 'Lists nodes.',
        'x-scantor-scope': 'admin',
        'x-admin-only': true,
        'x-mcp': true,
        responses: { 200: { description: 'nodes' } },
      },
    },
    '/api/users': {
      get: { tags: ['users'], operationId: 'listUsers', summary: 'List users', description: 'x', 'x-scantor-scope': 'admin', 'x-admin-only': true, 'x-mcp': false, responses: { 200: { description: 'users' } } },
    },
    '/mcp': { post: { operationId: 'mcp', 'x-mcp': true, responses: { 200: { description: 'x' } } } },
  },
}

describe('snakeCase', () => {
  it.each([
    ['getScan', 'get_scan'],
    ['retryFailedAnalyses', 'retry_failed_analyses'],
    ['getAuthoringGuide', 'get_authoring_guide'],
    ['listOAuthApps', 'list_oauth_apps'],
  ])('%s → %s', (input, output) => {
    expect(snakeCase(input)).toBe(output)
  })
})

describe('annotations and levels', () => {
  it.each([
    ['GET', {}, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, 'read'],
    ['POST', { 'x-read-only': true }, { readOnlyHint: true, destructiveHint: false, idempotentHint: true }, 'read'],
    ['POST', {}, { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, 'write'],
    ['POST', { 'x-destructive': true }, { readOnlyHint: false, destructiveHint: true, idempotentHint: false }, 'write'],
    ['PUT', {}, { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, 'write'],
    ['DELETE', {}, { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, 'write'],
    ['GET', { 'x-admin-only': true }, { readOnlyHint: true }, 'admin'],
  ])('%s %j', (method, operation, hints, level) => {
    expect(annotationsFor(method, operation, 'Title')).toMatchObject({ ...hints, openWorldHint: false, title: 'Title' })
    expect(requirementFor(method, operation)).toBe(level)
  })
})

describe('generateCatalogue', () => {
  it('generates the opted-in /api tools with levels, annotations and the wait clamp', async () => {
    const catalogue = await generateCatalogue(spec)
    const byName = Object.fromEntries(catalogue.map((tool) => [tool.name, tool]))
    expect(Object.keys(byName).sort()).toEqual(['cancel_scan', 'delete_scan', 'get_scan', 'list_nodes', 'query_analyses'])
    expect(byName.get_scan).toMatchObject({ operationId: 'getScan', method: 'GET', path: '/api/scans/{scanId}', requirement: 'read' })
    expect(byName.query_analyses?.requirement).toBe('read')
    expect(byName.list_nodes?.requirement).toBe('admin')
    expect(byName.cancel_scan?.config.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false, title: 'Cancel a scan' })
    expect(byName.get_scan?.config.description).toContain(UNTRUSTED_NOTE)
    expect(byName.list_nodes?.config.description).not.toContain(UNTRUSTED_NOTE)
    const wait = (byName.get_scan?.tool.inputSchema as { properties: Record<string, { maximum?: number }> }).properties.wait
    expect(wait?.maximum).toBe(MCP_MAX_WAIT_SECONDS)
  })

  it('filters tools by level', async () => {
    const catalogue = await generateCatalogue(spec)
    const names = (level: 'read' | 'write' | 'admin') => toolsForLevel(catalogue, level).map((tool) => tool.name).sort()
    expect(names('read')).toEqual(['get_scan', 'query_analyses'])
    expect(names('write')).toEqual(['cancel_scan', 'delete_scan', 'get_scan', 'query_analyses'])
    expect(names('admin')).toEqual(['cancel_scan', 'delete_scan', 'get_scan', 'list_nodes', 'query_analyses'])
  })
})
