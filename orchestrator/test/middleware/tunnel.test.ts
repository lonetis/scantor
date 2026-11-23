import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, send, setResponseStatus, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Tunnel requests in the first middleware (docs/auth.md §1, §4.5; security.md TUN-1, TUN-2): 00.request answers a
// mismatch with 421 and warns about it at most once a minute per kind, 01.tunnel refuses the internal prefixes with
// 404 notFound, and everything else passes with the origin on the event context.

/** Socket peers the mocked resolver takes for cloudflared (and so also for a trusted proxy). */
const tunnelPeers = new Set<string>()
const strip = (peer: string) => peer.replace(/^::ffff:/, '')

vi.mock('../../server/utils/trusted-proxy', () => ({
  proxyTrust: () => (peer: string) => tunnelPeers.has(strip(peer)),
  useTrustedProxies: () => ({ isHostPeer: (host: string, peer: string) => host === 'cloudflared' && tunnelPeers.has(strip(peer)) }),
}))

const { default: requestMiddleware } = await import('../../server/middleware/00.request')
const { default: pathMiddleware } = await import('../../server/middleware/01.path')
const { default: tunnelMiddleware } = await import('../../server/middleware/01.tunnel')
const { parseConfig, setConfigForTesting } = await import('../../server/utils/config')
const { normalizeError } = await import('../../server/utils/errors')
const { configureLogger } = await import('../../server/utils/logger')

const TUNNEL_HOST = 'tunnel.example.org'
const PUBLIC_HOST = 'scantor.example.com'

let server: Server | null = null
let port = 0
let lines: Record<string, unknown>[] = []

function configure(tunnelUrl: string | null): void {
  setConfigForTesting(
    parseConfig({
      SCANTOR_PUBLIC_URL: `https://${PUBLIC_HOST}`,
      SCANTOR_EDITOR_URL: 'https://editor.example.com',
      SCANTOR_TUNNEL_URL: tunnelUrl ?? '',
    }).config,
  )
}

beforeEach(async () => {
  tunnelPeers.clear()
  lines = []
  configureLogger({ level: 'info', format: 'json', write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) })
  configure(`https://${TUNNEL_HOST}`)
  const app = createApp({
    onError: (error, event) => {
      const normalized = normalizeError(error)
      // as utils/error-handler.ts does for the access log line
      event.context.errorCode = normalized.body.error.code
      setResponseStatus(event, normalized.status)
      return send(event, JSON.stringify(normalized.body), 'application/json')
    },
  })
  app.use(requestMiddleware)
  app.use(pathMiddleware)
  app.use(tunnelMiddleware)
  app.use(defineEventHandler((event) => ({ reached: event.path, origin: event.context.requestOrigin, clientIp: event.context.clientIp })))
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  setConfigForTesting(null)
  configureLogger({ level: 'error', write: () => {} })
  vi.useRealTimers()
})

interface Answer {
  status: number
  contentType: string
  text: string
  body: { reached?: string; origin?: string; clientIp?: string; error?: { code: string; message: string } } | null
}

function get(path: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const contentType = String(res.headers['content-type'] ?? '')
        resolve({ status: res.statusCode ?? 0, contentType, text, body: contentType.includes('json') ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** A request as cloudflared forwards it: from the tunnel peer, with the tunnel host. */
function throughTunnel(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  tunnelPeers.add('127.0.0.1')
  return get(path, { host: TUNNEL_HOST, ...headers })
}

/** Waits until the access log line of the last request is written (it is written when the response finished). */
async function accessLog(): Promise<Record<string, unknown>[]> {
  await vi.waitFor(() => expect(lines.some((line) => line.msg === 'request')).toBe(true))
  return lines.filter((line) => line.msg === 'request')
}

describe('00.request', () => {
  it('passes a tunnel request with the origin and the rightmost forwarded client address', async () => {
    const answer = await throughTunnel('/api/scans?limit=1', { 'x-forwarded-for': '198.51.100.1, 203.0.113.7' })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ reached: '/api/scans?limit=1', origin: 'tunnel', clientIp: '203.0.113.7' })
    expect((await accessLog())[0]).toMatchObject({ path: '/api/scans', origin: 'tunnel', status: 200, clientIp: '203.0.113.7' })
  })

  it('passes a public request as public', async () => {
    const answer = await get('/api/scans', { host: PUBLIC_HOST, 'x-forwarded-for': '203.0.113.7' })
    expect(answer.status).toBe(200)
    // Not from a trusted proxy: the forwarded address is ignored.
    expect(answer.body).toEqual({ reached: '/api/scans', origin: 'public', clientIp: '127.0.0.1' })
    expect((await accessLog())[0]).toMatchObject({ origin: 'public' })
  })

  it.each([
    ['the tunnel host from another peer', () => get('/api/scans', { host: TUNNEL_HOST })],
    ['the tunnel host with the default port from another peer', () => get('/', { host: `${TUNNEL_HOST}:443` })],
    ['the public host from cloudflared', () => throughTunnel('/api/scans', { host: PUBLIC_HOST })],
    ['another host from cloudflared', () => throughTunnel('/mcp', { host: 'evil.example' })],
    ['the tunnel host on another port from cloudflared', () => throughTunnel('/', { host: `${TUNNEL_HOST}:8443` })],
  ])('answers 421 Misdirected Request in plain text for %s', async (_name, send) => {
    const answer = await send()
    expect(answer.status).toBe(421)
    expect(answer.contentType).toBe('text/plain; charset=utf-8')
    expect(answer.text).toBe('Misdirected Request: the tunnel URL is served only through the Cloudflare Tunnel, which serves nothing else.\n')
  })

  it('answers nothing with 421 without a tunnel URL', async () => {
    configure(null)
    tunnelPeers.add('127.0.0.1')
    for (const host of [TUNNEL_HOST, PUBLIC_HOST]) {
      const answer = await get('/api/node/assignments', { host })
      expect(answer.status, host).toBe(200)
      expect(answer.body?.origin, host).toBeUndefined()
    }
  })

  it('warns about a mismatch with host, peer and path, at most once a minute per kind', async () => {
    // A system time far from that of the other tests, whose mismatches started their own minutes.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const warnings = () => lines.filter((line) => line.level === 'warn')

    expect((await get('/api/scans?token=secret', { host: TUNNEL_HOST })).status).toBe(421)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({
      msg: 'misdirected tunnel request refused with 421: the tunnel route must target http://orchestrator:3000 with the host of the tunnel URL',
      component: 'http',
      kind: 'tunnel host from another peer',
      host: TUNNEL_HOST,
      path: '/api/scans',
    })
    expect(String(warnings()[0]!.peer)).toMatch(/127\.0\.0\.1$/)
    expect(typeof warnings()[0]!.requestId).toBe('string')
    // The 421 gets no access log line.
    expect(lines.filter((line) => line.msg === 'request')).toEqual([])

    // The same kind again within the minute is not logged; the other kind is.
    expect((await get('/mcp', { host: TUNNEL_HOST })).status).toBe(421)
    expect(warnings()).toHaveLength(1)
    expect((await throughTunnel('/', { host: PUBLIC_HOST })).status).toBe(421)
    expect(warnings()).toHaveLength(2)
    expect(warnings()[1]).toMatchObject({ kind: 'another host from cloudflared', host: PUBLIC_HOST, path: '/' })
    expect((await throughTunnel('/x', { host: 'evil.example' })).status).toBe(421)
    expect(warnings()).toHaveLength(2)

    // A minute later each kind is logged once more.
    vi.setSystemTime(new Date('2030-01-01T00:00:59.999Z'))
    tunnelPeers.clear()
    expect((await get('/', { host: TUNNEL_HOST })).status).toBe(421)
    expect(warnings()).toHaveLength(2)
    vi.setSystemTime(new Date('2030-01-01T00:01:00Z'))
    expect((await get('/', { host: TUNNEL_HOST })).status).toBe(421)
    expect(warnings()).toHaveLength(3)
    expect(warnings()[2]).toMatchObject({ kind: 'tunnel host from another peer', path: '/' })
  })
})

describe('01.tunnel', () => {
  it.each([
    '/api/node',
    '/api/node/assignments',
    '/api/runtime/bootstrap',
    '/api/script-runtime/bootstrap',
    '/api/tools/session?target=rabbitmq',
    '/api/tools/forward-auth',
    '/api/registry/token?service=registry',
    '/api/editor',
    '/api/editor/session',
  ])('answers 404 notFound through the tunnel for %s', async (path) => {
    const answer = await throughTunnel(path)
    expect(answer.status).toBe(404)
    expect(answer.body).toEqual({ error: { code: 'notFound', message: `no operation at ${path.split('?')[0]}` } })
    expect((await accessLog())[0]).toMatchObject({ origin: 'tunnel', status: 404, code: 'notFound' })
  })

  it.each(['/api/nodes', '/api/nodes/join', '/api/scans', '/api/info', '/api/auth/get-session', '/mcp', '/', '/editor', '/admin/tools', '/_nuxt/entry.js'])(
    'lets %s through the tunnel',
    async (path) => {
      const answer = await throughTunnel(path)
      expect(answer.status).toBe(200)
      expect(answer.body).toMatchObject({ reached: path, origin: 'tunnel' })
    },
  )

  it('refuses nothing on the public origin', async () => {
    for (const path of ['/api/node/assignments', '/api/tools/session', '/api/editor/session']) {
      const answer = await get(path, { host: PUBLIC_HOST })
      expect(answer.status, path).toBe(200)
      expect(answer.body, path).toMatchObject({ reached: path, origin: 'public' })
    }
  })

  it('judges the canonical path: a dot-segment spelling is refused by 01.path first', async () => {
    const answer = await throughTunnel('/api/scans/../node/assignments')
    expect(answer.status).toBe(400)
    expect(answer.body?.error?.code).toBe('badRequest')
  })
})
