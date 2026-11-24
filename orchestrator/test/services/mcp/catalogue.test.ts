import { buildHttpRequest } from 'mcp-from-openapi'
import { describe, expect, it } from 'vitest'
import { type CatalogueTool, generateCatalogue, snakeCase, toolsForLevel } from '../../../server/services/mcp/tools'
import { buildOperationRegistry } from '../../../server/utils/operations'
import { routeOpenApiDocument } from '../../helpers/route-openapi'

// The MCP tool catalogue generated from the real API route metadata (docs/mcp.md §4.1, §5): one tool per operation
// with x-mcp: true, and update_node_daemon_overrides is an admin tool whose arguments are the merge patch of the REST
// body.

const NODE_ID = '2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'

let catalogue: Promise<CatalogueTool[]> | null = null
async function tool(name: string): Promise<CatalogueTool> {
  catalogue ??= generateCatalogue(routeOpenApiDocument())
  const found = (await catalogue).find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

describe('the MCP tool catalogue of the API routes', () => {
  it('holds one tool per x-mcp operation, named snake_case(operationId)', async () => {
    catalogue ??= generateCatalogue(routeOpenApiDocument())
    const tools = await catalogue
    const operations = buildOperationRegistry(routeOpenApiDocument()).operations.filter((operation) => operation.mcp)
    expect(operations.length).toBeGreaterThan(0)
    expect(tools.map((candidate) => candidate.operationId).sort()).toEqual(operations.map((operation) => operation.operationId).sort())
    for (const candidate of tools) expect(candidate.name, candidate.operationId).toBe(snakeCase(candidate.operationId))
  })

  it('offers update_node_daemon_overrides to admin agents only', async () => {
    const update = await tool('update_node_daemon_overrides')
    expect(update).toMatchObject({
      operationId: 'updateNodeDaemonOverrides',
      method: 'PATCH',
      path: '/api/nodes/{nodeId}/daemon-overrides',
      requirement: 'admin',
    })
    expect(update.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false })
    expect(toolsForLevel(await catalogue!, 'write').map((candidate) => candidate.name)).not.toContain('update_node_daemon_overrides')
    expect((await catalogue!).map((candidate) => candidate.name)).not.toContain('delete_node_daemon_overrides')
  })

  it('checks the merge patch like the REST body', async () => {
    const { checkArguments } = await tool('update_node_daemon_overrides')
    expect(checkArguments({ nodeId: NODE_ID, maxWorkers: 4, dns: { mode: 'iterative', upstreams: null } })).toEqual([])
    expect(checkArguments({ nodeId: NODE_ID, logLevel: null, dns: null })).toEqual([])
    expect(checkArguments({ nodeId: NODE_ID, maxWorkers: 0 })).toEqual([{ path: 'maxWorkers', message: 'must be >= 1' }])
    expect(checkArguments({ nodeId: NODE_ID, dns: { mode: 'fast' } }).map((issue) => issue.path)).toContain('dns.mode')
    expect(checkArguments({ nodeId: NODE_ID, dns: { bogus: 1 } })).toContainEqual({ path: 'dns.bogus', message: 'unknown field' })
    expect(checkArguments({ nodeId: NODE_ID, url: 'https://elsewhere.example' })).toContainEqual({ path: 'url', message: 'unknown field' })
  })

  it('sends the patch as the PATCH body', async () => {
    const update = await tool('update_node_daemon_overrides')
    const request = buildHttpRequest(
      update.tool,
      { nodeId: NODE_ID, maxWorkers: 4, dns: { mode: 'disabled', upstreams: null } },
      { baseUrl: 'http://127.0.0.1:1' },
    )
    expect(request.method).toBe('PATCH')
    expect(new URL(request.url).pathname).toBe(`/api/nodes/${NODE_ID}/daemon-overrides`)
    expect(JSON.parse(String(request.body))).toEqual({ maxWorkers: 4, dns: { mode: 'disabled', upstreams: null } })
  })

  it('lets list_nodes include the daemon configuration', async () => {
    const list = await tool('list_nodes')
    expect(list.checkArguments({ include: 'daemonConfig' })).toEqual([])
    expect(list.checkArguments({ include: 'everything' }).map((issue) => issue.path)).toEqual(['include'])
  })
})
