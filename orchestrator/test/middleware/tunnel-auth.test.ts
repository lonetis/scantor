import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, send, setResponseStatus, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../server/utils/config'

// The auth middleware per origin (docs/auth.md §4.2, §4.5, §5.2; security.md TUN-4): credentials are looked up on the
// better-auth instance of the request's origin, and a cookie-authenticated mutation needs an Origin trusted by that
// origin only: the tunnel origin is refused on the public URL and the public origins are refused through the tunnel.

const tunnelPeers = new Set<string>()
const strip = (peer: string) => peer.replace(/^::ffff:/, '')
/** Every credential lookup: which credential and on which origin's instance. */
const lookups: { credential: 'cookie' | 'apiKey'; origin: unknown }[] = []

const KEY = `sk_scantor_${'A'.repeat(64)}`
const USER = { id: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11', email: 'u@example.com', name: 'U', role: 'user' }

vi.mock('../../server/utils/trusted-proxy', () => ({
  proxyTrust: () => (peer: string) => tunnelPeers.has(strip(peer)),
  useTrustedProxies: () => ({ isHostPeer: (host: string, peer: string) => host === 'cloudflared' && tunnelPeers.has(strip(peer)) }),
}))
vi.mock('../../server/utils/credential-lookup', () => ({
  lookupSession: async (credential: Headers, origin?: unknown) => {
    lookups.push({ credential: credential.has('x-api-key') ? 'apiKey' : 'cookie', origin })
    const valid = credential.get('x-api-key') === KEY || credential.get('cookie') === 'scantor.session_token=valid'
    return { result: valid ? { session: { id: 'session-1', createdAt: new Date() }, user: USER } : null }
  },
}))
vi.mock('../../server/utils/operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/utils/operations')>()
  const op = (operationId: string) => ({ operationId, tags: ['t'], 'x-scantor-scope': 'owner', 'x-mcp': false })
  const registry = actual.buildOperationRegistry({ paths: { '/api/scans': { get: op('listScans'), post: op('startScan') } } })
  return { ...actual, useOperationRegistry: async () => registry }
})

const { default: authMiddleware } = await import('../../server/middleware/10.auth')
const { resetBootRegistry, runBoot } = await import('../../server/utils/boot')
const { parseConfig, setConfigForTesting } = await import('../../server/utils/config')
const { normalizeError } = await import('../../server/utils/errors')
const { useLogger } = await import('../../server/utils/logger')

const PUBLIC_URL = 'http://localhost:3000'
const TUNNEL_URL = 'https://tunnel.example.org'
const TUNNEL_HOST = 'tunnel.example.org'

let server: Server | null = null
let port = 0

function configure(tunnelUrl: string | null): void {
  setConfigForTesting(parseConfig({ SCANTOR_PUBLIC_URL: PUBLIC_URL, SCANTOR_TUNNEL_URL: tunnelUrl ?? '' }).config)
}

beforeEach(async () => {
  tunnelPeers.clear()
  lookups.length = 0
  configure(TUNNEL_URL)
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
  app.use(defineEventHandler((event) => ({ via: (event.context.principal as { via?: string } | null)?.via ?? null })))
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  setConfigForTesting(null)
  resetBootRegistry()
})

function call(
  method: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: { via?: string | null; error?: { code: string; message: string } } }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/scans', method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end()
  })
}

const SESSION = { cookie: 'scantor.session_token=valid' }

/** A request as cloudflared forwards it. */
function throughTunnel(method: string, headers: Record<string, string>) {
  tunnelPeers.add('127.0.0.1')
  return call(method, { host: TUNNEL_HOST, ...headers })
}

function onPublic(method: string, headers: Record<string, string>) {
  return call(method, { host: 'localhost:3000', ...headers })
}

const UNTRUSTED = { status: 403, body: { error: { code: 'forbidden', message: 'untrusted request origin' } } }

describe('CSRF per origin', () => {
  it('accepts a session mutation through the tunnel only with the tunnel origin', async () => {
    expect(await throughTunnel('POST', { ...SESSION, origin: TUNNEL_URL })).toEqual({ status: 200, body: { via: 'session' } })
    for (const origin of [PUBLIC_URL, 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://evil.example', 'null']) {
      expect(await throughTunnel('POST', { ...SESSION, origin }), origin).toEqual(UNTRUSTED)
    }
    expect(await throughTunnel('POST', SESSION)).toEqual(UNTRUSTED)
  })

  it('accepts a session mutation on the public URL only with the public origins', async () => {
    for (const origin of [PUBLIC_URL, 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(await onPublic('POST', { ...SESSION, origin }), origin).toEqual({ status: 200, body: { via: 'session' } })
    }
    expect(await onPublic('POST', { ...SESSION, origin: TUNNEL_URL })).toEqual(UNTRUSTED)
  })

  it('refuses the tunnel origin on the public URL of an instance without a tunnel URL', async () => {
    configure(null)
    expect(await onPublic('POST', { ...SESSION, origin: TUNNEL_URL })).toEqual(UNTRUSTED)
    // Without a tunnel URL the tunnel host is an ordinary public request, with the public origins.
    expect(await throughTunnel('POST', { ...SESSION, origin: TUNNEL_URL })).toEqual(UNTRUSTED)
    expect(await throughTunnel('POST', { ...SESSION, origin: PUBLIC_URL })).toEqual({ status: 200, body: { via: 'session' } })
    expect(lookups.map((lookup) => lookup.origin)).toEqual(['public', 'public', 'public'])
  })

  it('needs no Origin for reads and for API keys', async () => {
    expect(await throughTunnel('GET', SESSION)).toEqual({ status: 200, body: { via: 'session' } })
    expect(await throughTunnel('POST', { 'x-api-key': KEY })).toEqual({ status: 200, body: { via: 'apiKey' } })
    expect(await throughTunnel('POST', { authorization: `Bearer ${KEY}`, origin: PUBLIC_URL })).toEqual({ status: 200, body: { via: 'apiKey' } })
  })
})

describe('credential lookups per origin', () => {
  it('looks cookies and API keys up on the instance of the request origin', async () => {
    await throughTunnel('GET', SESSION)
    await throughTunnel('GET', { 'x-api-key': KEY })
    tunnelPeers.clear()
    await onPublic('GET', SESSION)
    await onPublic('GET', { 'x-api-key': KEY })
    expect(lookups).toEqual([
      { credential: 'cookie', origin: 'tunnel' },
      { credential: 'apiKey', origin: 'tunnel' },
      { credential: 'cookie', origin: 'public' },
      { credential: 'apiKey', origin: 'public' },
    ])
  })

  it('answers 401 for a cookie its origin does not know', async () => {
    expect(await throughTunnel('GET', { cookie: 'scantor.session_token=other' })).toEqual({
      status: 401,
      body: { error: { code: 'unauthorized', message: 'session expired or invalid' } },
    })
    expect(lookups).toEqual([{ credential: 'cookie', origin: 'tunnel' }])
  })
})
