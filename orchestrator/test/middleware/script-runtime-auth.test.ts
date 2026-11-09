import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, send, setResponseStatus, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../server/utils/config'
import type { ScriptRunPrincipal } from '../../server/utils/principal'

// The script runtime API in the auth middleware (docs/scripts.md, docs/auth.md): the socket peer must lie in the
// scripts network and must not be a trusted proxy (403 before any token is looked at), then only a script-run token
// is accepted (401), and a script-run token is useless on every other route.

const peers = new Set<string>()
const trustedProxies = new Set<string>()
const tokens = new Map<string, ScriptRunPrincipal>()
const lookups: string[] = []

vi.mock('../../server/utils/script-network', () => ({
  isScriptNetworkPeer: (address: string | null | undefined) => !!address && peers.has(address.replace(/^::ffff:/, '')),
}))
vi.mock('../../server/utils/script-run-tokens', () => ({
  resolveScriptRunToken: async (token: string) => {
    lookups.push(token)
    return tokens.get(token) ?? null
  },
}))
vi.mock('../../server/utils/trusted-proxy', () => ({ proxyTrust: () => (peer: string) => trustedProxies.has(peer) }))
vi.mock('../../server/utils/operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/operations')>()
  const op = (operationId: string, scope: string) => ({ operationId, tags: ['t'], 'x-scantor-scope': scope, 'x-mcp': false })
  const registry = actual.buildOperationRegistry({
    paths: {
      '/api/script-runtime/bootstrap': { get: op('scriptRuntimeBootstrap', 'scriptRun') },
      '/api/runtime/bootstrap': { get: op('runtimeBootstrap', 'worker') },
      '/api/scans': { get: op('listScans', 'owner') },
    },
  })
  return { ...actual, useOperationRegistry: async () => registry }
})

const { default: authMiddleware } = await import('../../server/middleware/10.auth')
const { resetBootRegistry, runBoot } = await import('../../server/utils/boot')
const { normalizeError } = await import('../../server/utils/errors')
const { useLogger } = await import('../../server/utils/logger')

const RUN = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'
const TOKEN = `ssr_${RUN}.${'A'.repeat(43)}`
const principal: ScriptRunPrincipal = {
  kind: 'scriptRun',
  scriptRun: { id: RUN, userId: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11', scriptId: 's', scanIds: [], limit: null },
}

let server: Server | null = null
let port = 0

beforeEach(async () => {
  peers.clear()
  trustedProxies.clear()
  tokens.clear()
  lookups.length = 0
  tokens.set(TOKEN, principal)
  resetBootRegistry()
  await runBoot({ config: () => ({ components: [] }) as unknown as Config, log: useLogger('test') })
  const app = createApp({
    onError: (error, event) => {
      const normalized = normalizeError(error)
      setResponseStatus(event, normalized.status)
      return send(event, JSON.stringify(normalized.body), 'application/json')
    },
  })
  app.use(authMiddleware)
  app.use(defineEventHandler((event) => ({ principal: (event.context.principal as { kind?: string } | null)?.kind ?? null })))
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  resetBootRegistry()
})

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: { principal?: string; error?: { code: string } } }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end()
  })
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

describe('the script runtime API in the auth middleware', () => {
  it('accepts a script-run token from a peer in the scripts network', async () => {
    peers.add('127.0.0.1')
    expect(await get('/api/script-runtime/bootstrap', bearer(TOKEN))).toEqual({ status: 200, body: { principal: 'scriptRun' } })
  })

  it('answers 403 to peers outside the scripts network without looking at the token', async () => {
    const response = await get('/api/script-runtime/bootstrap', bearer(TOKEN))
    expect(response.status).toBe(403)
    expect(response.body.error?.code).toBe('forbidden')
    expect(lookups).toEqual([])
  })

  it('ignores X-Forwarded-For outside nuxt dev: only the socket peer counts', async () => {
    peers.add('172.30.0.5')
    expect((await get('/api/script-runtime/bootstrap', { ...bearer(TOKEN), 'x-forwarded-for': '172.30.0.5' })).status).toBe(403)
    expect(lookups).toEqual([])
  })

  it('answers 403 when the peer is a trusted reverse proxy, even inside the scripts network', async () => {
    peers.add('127.0.0.1')
    trustedProxies.add('127.0.0.1')
    expect((await get('/api/script-runtime/bootstrap', bearer(TOKEN))).status).toBe(403)
    expect(lookups).toEqual([])
  })

  it('answers 401 without a valid script-run token', async () => {
    peers.add('127.0.0.1')
    for (const headers of [
      {},
      bearer(`ssr_${RUN}.${'B'.repeat(43)}`),
      bearer(`swt_${RUN}.${'A'.repeat(43)}`),
      bearer('sk_scantor_x'),
      { cookie: 'scantor.session_token=x' },
    ]) {
      const response = await get('/api/script-runtime/bootstrap', headers)
      expect(response.status, JSON.stringify(headers)).toBe(401)
      expect(response.body.error?.code).toBe('unauthorized')
    }
    // Only ssr_ values reach the token lookup.
    expect(lookups).toEqual([`ssr_${RUN}.${'B'.repeat(43)}`])
  })

  it('answers 404 for an unknown script runtime path once authenticated', async () => {
    peers.add('127.0.0.1')
    expect((await get('/api/script-runtime/nope', bearer(TOKEN))).status).toBe(404)
  })

  it('never accepts a script-run token on worker or user routes', async () => {
    peers.add('127.0.0.1')
    expect((await get('/api/runtime/bootstrap', bearer(TOKEN))).status).toBe(401)
    expect((await get('/api/scans', bearer(TOKEN))).status).toBe(401)
  })
})
