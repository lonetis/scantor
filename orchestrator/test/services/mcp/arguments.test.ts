import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { advertisedInputSchema, argumentIssue, clampWait, compileArgumentsCheck } from '../../../server/services/mcp/arguments'
import { generateCatalogue, MCP_MAX_WAIT_SECONDS } from '../../../server/services/mcp/tools'

// Tool arguments (docs/mcp.md §4.3, §4.7, §4.8): the SDK advertises the input schema but lets every argument object
// through, so `wait` above 50 reaches the bridge's clamp and schema violations become the structured validationFailed.

const getScanSchema = {
  type: 'object',
  properties: {
    scanId: { type: 'string', format: 'uuid' },
    wait: { type: 'integer', minimum: 0, maximum: MCP_MAX_WAIT_SECONDS },
    settings: { type: 'object', properties: { workers: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  },
  required: ['scanId'],
  additionalProperties: false,
}

const SCAN_ID = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'

describe('compileArgumentsCheck', () => {
  const check = compileArgumentsCheck(getScanSchema)

  it('accepts valid arguments', () => {
    expect(check({ scanId: SCAN_ID, wait: 50 })).toEqual([])
  })

  it('reports every violation with a dot path, like the REST zod issues', () => {
    expect(check({})).toEqual([{ path: 'scanId', message: 'is required' }])
    expect(check({ scanId: 'not-a-uuid', wait: -1, bogus: true })).toEqual(
      expect.arrayContaining([
        { path: 'scanId', message: 'must match format "uuid"' },
        { path: 'wait', message: 'must be >= 0' },
        { path: 'bogus', message: 'unknown field' },
      ]),
    )
    expect(check({ scanId: SCAN_ID, settings: { workers: 0, extra: 1 } })).toEqual(
      expect.arrayContaining([
        { path: 'settings.workers', message: 'must be >= 1' },
        { path: 'settings.extra', message: 'unknown field' },
      ]),
    )
  })

  it('unescapes JSON pointer segments', () => {
    expect(argumentIssue({ keyword: 'type', instancePath: '/files/a~1b~0c', schemaPath: '#', params: {}, message: 'must be string' })).toEqual({
      path: 'files.a/b~c',
      message: 'must be string',
    })
  })
})

describe('clampWait', () => {
  it('clamps a numeric wait above the maximum and leaves everything else alone', () => {
    expect(clampWait({ scanId: SCAN_ID, wait: 120 }, 50)).toEqual({ scanId: SCAN_ID, wait: 50 })
    expect(clampWait({ wait: 50 }, 50)).toEqual({ wait: 50 })
    expect(clampWait({ wait: '120' }, 50)).toEqual({ wait: '120' })
    expect(clampWait({}, 50)).toEqual({})
  })
})

describe('advertisedInputSchema', () => {
  it('advertises the JSON Schema and accepts every argument object', async () => {
    const schema = advertisedInputSchema(getScanSchema)
    expect(schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })).toBe(getScanSchema)
    expect(await schema['~standard'].validate({ wait: 120, scanId: 'x' })).toEqual({ value: { wait: 120, scanId: 'x' } })
  })
})

/** One JSON-RPC request through the SDK's stateless HTTP handler, as server.ts serves `/mcp`. */
async function rpc(server: () => McpServer, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = createMcpHandler(async () => server(), { legacy: 'stateless', responseMode: 'auto' })
  const response = await handler.fetch(
    new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )
  const text = await response.text()
  // An SSE response carries the JSON-RPC message in its `data:` line.
  const data = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice('data: '.length)
  if (!data) throw new Error(`no JSON-RPC message in the response: ${text}`)
  return JSON.parse(data) as Record<string, unknown>
}

describe('generated tools in the MCP SDK', () => {
  const spec = {
    openapi: '3.1.0',
    info: { title: 'scantor API', version: 'test' },
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
          responses: { 200: { description: 'scan' } },
        },
      },
    },
  }

  async function serverWithGetScan(received: unknown[]): Promise<() => McpServer> {
    const [tool] = await generateCatalogue(spec)
    return () => {
      const server = new McpServer({ name: 'scantor', version: 'test' }, { capabilities: { tools: { listChanged: false } } })
      server.registerTool(tool!.name, tool!.config, (input: unknown) => {
        received.push(input)
        return { content: [{ type: 'text', text: JSON.stringify(tool!.checkArguments(clampWait(input as Record<string, unknown>, MCP_MAX_WAIT_SECONDS))) }] }
      })
      return server
    }
  }

  it('lists the wait input with a maximum of 50', async () => {
    const body = await rpc(await serverWithGetScan([]), 'tools/list', {})
    const [listed] = (body.result as { tools: { inputSchema: { properties: { wait: { maximum: number } } } }[] }).tools
    expect(listed?.inputSchema.properties.wait.maximum).toBe(MCP_MAX_WAIT_SECONDS)
  })

  it('passes a wait above 50 and schema-invalid arguments to the tool instead of failing in the SDK', async () => {
    const received: unknown[] = []
    const server = await serverWithGetScan(received)

    const clamped = await rpc(server, 'tools/call', { name: 'get_scan', arguments: { scanId: SCAN_ID, wait: 120 } })
    expect((clamped.result as { isError?: boolean }).isError).toBeFalsy()
    expect(received.at(-1)).toEqual({ scanId: SCAN_ID, wait: 120 })
    expect(JSON.parse((clamped.result as { content: { text: string }[] }).content[0]!.text)).toEqual([])

    const invalid = await rpc(server, 'tools/call', { name: 'get_scan', arguments: { scanId: 'not-a-uuid' } })
    expect(received.at(-1)).toEqual({ scanId: 'not-a-uuid' })
    expect(JSON.parse((invalid.result as { content: { text: string }[] }).content[0]!.text)).toEqual([{ path: 'scanId', message: 'must match format "uuid"' }])
  })
})
