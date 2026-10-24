import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, defineEventHandler, getQuery, type H3Event, readBody, send, setResponseStatus, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import authMiddleware from '../../../server/middleware/10.auth'
import { callApiTool } from '../../../server/services/mcp/bridge'
import { type CatalogueTool, generateCatalogue } from '../../../server/services/mcp/tools'
import { resetBootRegistry, runBoot } from '../../../server/utils/boot'
import type { Config } from '../../../server/utils/config'
import { normalizeError } from '../../../server/utils/errors'
import { INTERNAL_AUTH_HEADER, mintInternalCapability } from '../../../server/utils/internal-auth'
import { useLogger } from '../../../server/utils/logger'
import { closeLoopbackListener, setLoopbackHandler, useLoopbackOrigin } from '../../../server/utils/loopback'
import { setOpenApiDocumentLoader } from '../../../server/utils/operations'
import type { UserPrincipal } from '../../../server/utils/principal'

// MCP tool calls through the real auth middleware (docs/mcp.md §4.3, docs/auth.md §5.2). Regression: under
// `nuxt dev` the app runs in a worker behind a unix socket, where requests have no peer address, so every
// `tools/call` that went through the public listener failed with 401 'invalid or expired internal capability'.
// Tool calls now use the private loopback listener, the only place a capability is accepted.

const { USER } = vi.hoisted(() => ({
  USER: { id: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11', email: 'u@example.org', name: 'u', role: 'user' as const },
}))

vi.mock('../../../server/utils/user-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/user-cache')>()
  return {
    ...actual,
    getCachedUser: async (id: string) => (id === USER.id ? { ...USER, banned: false, banExpires: null, canRunPrivileged: false, maxWorkers: 0 } : null),
  }
})

const SCAN_ID = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'

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
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { filter: { type: 'object' } } } } } },
        responses: { 200: { description: 'items' } },
      },
    },
  },
}

const principal: UserPrincipal = {
  kind: 'user',
  via: 'mcp',
  user: USER,
  isAdmin: false,
  mcp: { clientId: 'client', level: 'read', operationId: '' },
}

/** The app as Nitro builds it for these routes: the auth middleware, then the handlers, errors as the envelope. */
function createTestApp() {
  const app = createApp({
    onError: (error, event) => {
      const normalized = normalizeError(error)
      setResponseStatus(event, normalized.status)
      return send(event, JSON.stringify(normalized.body), 'application/json')
    },
  })
  app.use(authMiddleware)
  const router = createRouter()
  const seen = (event: H3Event) => {
    const user = event.context.principal as UserPrincipal
    return { via: user.via, userId: user.user.id, operationId: user.mcp?.operationId, path: event.path }
  }
  router.get('/api/scans/:scanId', defineEventHandler((event) => ({ ...seen(event), query: getQuery(event) })))
  router.post('/api/scans/:scanId/analyses/query', defineEventHandler(async (event) => ({ ...seen(event), body: await readBody(event) })))
  app.use(router)
  return app
}

/** A GET on a unix socket listener, like Nuxt's dev proxy talking to the Nitro dev worker. */
function getOverUnixSocket(socketPath: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path, method: 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.once('error', reject)
    req.end()
  })
}

let tools: Map<string, CatalogueTool>
let devWorker: Server
let socketDir: string
let socketPath: string

beforeAll(async () => {
  resetBootRegistry()
  await runBoot({ config: () => ({ components: [] }) as unknown as Config, log: useLogger('test') })
  setOpenApiDocumentLoader(async () => spec)
  tools = new Map((await generateCatalogue(spec)).map((tool) => [tool.operationId, tool]))

  const listener = toNodeListener(createTestApp())
  setLoopbackHandler(listener)
  socketDir = mkdtempSync(join(tmpdir(), 'scantor-mcp-'))
  socketPath = join(socketDir, 'nitro-worker.sock')
  devWorker = createServer(listener)
  await new Promise<void>((resolve) => devWorker.listen(socketPath, resolve))
})

afterAll(async () => {
  await closeLoopbackListener()
  setLoopbackHandler(null)
  await new Promise<void>((resolve) => devWorker.close(() => resolve()))
  rmSync(socketDir, { recursive: true, force: true })
  resetBootRegistry()
})

describe('MCP tool calls over the loopback listener', () => {
  it('runs a GET tool as the MCP principal, bound to its operation', async () => {
    const result = await callApiTool(tools.get('getScan')!, { scanId: SCAN_ID }, principal, 'req-1', await useLoopbackOrigin())
    expect(result.isError).toBeUndefined()
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      via: 'mcp',
      userId: USER.id,
      operationId: 'getScan',
      path: `/api/scans/${SCAN_ID}`,
      query: {},
    })
  })

  it('clamps wait to 50 seconds before the call (docs/mcp.md §4.8)', async () => {
    const result = await callApiTool(tools.get('getScan')!, { scanId: SCAN_ID, wait: 120 }, principal, 'req-3', await useLoopbackOrigin())
    expect(result.isError).toBeUndefined()
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ path: `/api/scans/${SCAN_ID}?wait=50`, query: { wait: '50' } })
  })

  it('answers arguments that violate the input schema with the structured validationFailed, without a request', async () => {
    const call = (input: Record<string, unknown>) => callApiTool(tools.get('getScan')!, input, principal, 'req-4', 'http://127.0.0.1:1')
    for (const [input, issues] of [
      [{}, [{ path: 'scanId', message: 'is required' }]],
      [{ scanId: 'not-a-uuid' }, [{ path: 'scanId', message: 'must match format "uuid"' }]],
      [{ scanId: SCAN_ID, wait: -1 }, [{ path: 'wait', message: 'must be >= 0' }]],
    ] as const) {
      const result = await call(input)
      expect(result.isError).toBe(true)
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
        error: { httpStatus: 400, code: 'validationFailed', message: expect.stringMatching(/^invalid arguments for get_scan: /), details: { issues } },
      })
    }
  })

  it('runs a tool with a JSON body', async () => {
    const result = await callApiTool(tools.get('queryAnalyses')!, { scanId: SCAN_ID, filter: { status: 'failed' } }, principal, 'req-2', await useLoopbackOrigin())
    expect(result.isError).toBeUndefined()
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ operationId: 'queryAnalyses', body: { filter: { status: 'failed' } } })
  })

  it('refuses a capability presented on another listener (the dev worker socket has no peer address)', async () => {
    const pathname = `/api/scans/${SCAN_ID}`
    const capability = mintInternalCapability({ principal, method: 'GET', pathname, operationId: 'getScan' })
    const response = await getOverUnixSocket(socketPath, pathname, { [INTERNAL_AUTH_HEADER]: capability })
    expect(response.status).toBe(401)
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'unauthorized', message: 'invalid or expired internal capability' } })
  })

  it('refuses a capability for another path, even on the loopback listener', async () => {
    const capability = mintInternalCapability({ principal, method: 'GET', pathname: '/api/scans/other', operationId: 'getScan' })
    const response = await fetch(`${await useLoopbackOrigin()}/api/scans/${SCAN_ID}`, { headers: { [INTERNAL_AUTH_HEADER]: capability } })
    expect(response.status).toBe(401)
  })
})
