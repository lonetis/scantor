import { request } from 'node:http'
import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseConfig, setConfigForTesting } from '../../server/utils/config'
import { closeLoopbackListener, setLoopbackHandler, useLoopbackOrigin } from '../../server/utils/loopback'

// The Cloudflare Tunnel classification (docs/auth.md §4.5, security.md TUN-1, TUN-2): a request is a tunnel request
// only when its socket peer is cloudflared and its Host is the tunnel host; exactly one of the two is a mismatch.

/** The addresses the mocked resolver takes for cloudflared, and every question it was asked. */
const tunnelPeers = new Set<string>()
const peerChecks: { host: string; peer: string; refreshOnMiss: boolean }[] = []

vi.mock('../../server/utils/trusted-proxy', () => ({
  useTrustedProxies: () => ({
    isHostPeer: (host: string, peer: string, refreshOnMiss = false) => {
      peerChecks.push({ host, peer, refreshOnMiss })
      return host === 'cloudflared' && tunnelPeers.has(peer.replace(/^::ffff:/, ''))
    },
  }),
}))

const {
  classifyRequest,
  isTunnelHost,
  isTunnelRefusedPath,
  isTunnelRequest,
  originUrlOf,
  requestOriginOf,
  TUNNEL_PROFILE,
  TUNNEL_PROXY_HOST,
  TUNNEL_REFUSED_PREFIXES,
  TUNNEL_WAIT_MAX_SECONDS,
} = await import('../../server/utils/tunnel')

const PUBLIC_URL = 'https://scantor.example.com'
const TUNNEL_URL = 'https://tunnel.example.org'
const CLOUDFLARED = '10.10.1.9'
const OTHER_PEER = '10.10.1.5'

function configure(tunnelUrl: string | null): void {
  setConfigForTesting(
    parseConfig({ SCANTOR_PUBLIC_URL: PUBLIC_URL, SCANTOR_EDITOR_URL: 'https://editor.example.com', SCANTOR_TUNNEL_URL: tunnelUrl ?? '' }).config,
  )
}

/** An event with the given Host header (none when undefined) and socket peer (none when undefined). */
function event(host: string | undefined, peer: string | undefined): H3Event {
  return { node: { req: { headers: host === undefined ? {} : { host }, socket: { remoteAddress: peer } } }, context: {} } as unknown as H3Event
}

beforeEach(() => {
  tunnelPeers.clear()
  tunnelPeers.add(CLOUDFLARED)
  peerChecks.length = 0
})

afterEach(() => {
  setConfigForTesting(null)
})

describe('constants', () => {
  it('names the compose service, its profile and the wait cap below the 125 s Proxy Read Timeout of Cloudflare', () => {
    expect(TUNNEL_PROXY_HOST).toBe('cloudflared')
    expect(TUNNEL_PROFILE).toBe('cloudflare-tunnel')
    expect(TUNNEL_WAIT_MAX_SECONDS).toBe(90)
    expect(TUNNEL_REFUSED_PREFIXES).toEqual(['/api/node', '/api/runtime', '/api/script-runtime', '/api/tools', '/api/registry', '/api/editor'])
  })
})

describe('isTunnelRefusedPath', () => {
  it.each([
    '/api/node',
    '/api/node/',
    '/api/node/assignments',
    '/api/node/workers/x/logs',
    '/api/runtime/bootstrap',
    '/api/script-runtime',
    '/api/script-runtime/bootstrap',
    '/api/tools/session',
    '/api/tools/forward-auth',
    '/api/registry/token',
    '/api/editor',
    '/api/editor/session',
  ])('refuses %s', (path) => {
    expect(isTunnelRefusedPath(path)).toBe(true)
  })

  it.each([
    '/api/nodes',
    '/api/nodes/0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11',
    '/api/nodes/join',
    '/api/runtimes',
    '/api/toolsx',
    '/api/registryx/token',
    '/api/editors',
    '/api/scans',
    '/api/info',
    '/api/health',
    '/api/auth/get-session',
    '/mcp',
    '/editor',
    '/admin/tools',
    '/',
    '/API/node/assignments',
    '/x/api/node',
  ])('lets %s through', (path) => {
    expect(isTunnelRefusedPath(path)).toBe(false)
  })
})

describe('isTunnelHost', () => {
  it('compares the Host header as for an https origin', () => {
    expect(isTunnelHost('tunnel.example.org', TUNNEL_URL)).toBe(true)
    expect(isTunnelHost('Tunnel.Example.ORG:443', TUNNEL_URL)).toBe(true)
    expect(isTunnelHost('tunnel.example.org:8443', TUNNEL_URL)).toBe(false)
    expect(isTunnelHost('tunnel.example.org:8443', 'https://tunnel.example.org:8443')).toBe(true)
    expect(isTunnelHost('tunnel.example.org', 'https://tunnel.example.org:8443')).toBe(false)
    expect(isTunnelHost('tunnel.example.org:80', TUNNEL_URL)).toBe(false)
    expect(isTunnelHost('scantor.example.com', TUNNEL_URL)).toBe(false)
    expect(isTunnelHost('', TUNNEL_URL)).toBe(false)
    expect(isTunnelHost(undefined, TUNNEL_URL)).toBe(false)
  })
})

describe('classifyRequest', () => {
  it('classifies every request as public without a tunnel URL, and asks for no peer', () => {
    configure(null)
    for (const host of ['tunnel.example.org', 'scantor.example.com', undefined]) {
      for (const peer of [CLOUDFLARED, OTHER_PEER, undefined]) {
        const request = event(host, peer)
        expect(classifyRequest(request), `${host} from ${peer}`).toBe('public')
        expect(requestOriginOf(request)).toBe('public')
        expect(isTunnelRequest(request)).toBe(false)
      }
    }
    expect(peerChecks).toEqual([])
  })

  it.each([
    // host,                   peer,          classification
    ['tunnel.example.org', CLOUDFLARED, 'tunnel'],
    ['TUNNEL.example.org:443', CLOUDFLARED, 'tunnel'],
    ['tunnel.example.org', `::ffff:${CLOUDFLARED}`, 'tunnel'],
    ['tunnel.example.org:8443', CLOUDFLARED, 'mismatch'],
    ['scantor.example.com', CLOUDFLARED, 'mismatch'],
    ['editor.example.com', CLOUDFLARED, 'mismatch'],
    ['evil.example', CLOUDFLARED, 'mismatch'],
    [undefined, CLOUDFLARED, 'mismatch'],
    ['tunnel.example.org', OTHER_PEER, 'mismatch'],
    ['tunnel.example.org', '127.0.0.1', 'mismatch'],
    ['scantor.example.com', OTHER_PEER, 'public'],
    ['editor.example.com', OTHER_PEER, 'public'],
    ['evil.example', OTHER_PEER, 'public'],
    [undefined, OTHER_PEER, 'public'],
  ] as const)('Host %s from %s is %s', (host, peer, expected) => {
    configure(TUNNEL_URL)
    const request = event(host, peer)
    expect(classifyRequest(request)).toBe(expected)
    expect(requestOriginOf(request)).toBe(expected === 'tunnel' ? 'tunnel' : 'public')
    expect(isTunnelRequest(request)).toBe(expected === 'tunnel')
  })

  it('refreshes the resolver after a miss only for a request for the tunnel host', () => {
    configure(TUNNEL_URL)
    classifyRequest(event('tunnel.example.org', OTHER_PEER))
    classifyRequest(event('scantor.example.com', OTHER_PEER))
    expect(peerChecks).toEqual([
      { host: 'cloudflared', peer: OTHER_PEER, refreshOnMiss: true },
      { host: 'cloudflared', peer: OTHER_PEER, refreshOnMiss: false },
    ])
  })

  it('classifies a request once and memoizes the answer on its context', () => {
    configure(TUNNEL_URL)
    const request = event('tunnel.example.org', CLOUDFLARED)
    expect(classifyRequest(request)).toBe('tunnel')
    expect(request.context.requestOrigin).toBe('tunnel')
    tunnelPeers.clear()
    expect(classifyRequest(request)).toBe('tunnel')
    expect(requestOriginOf(request)).toBe('tunnel')
    expect(peerChecks).toHaveLength(1)
  })

  it('without a socket peer outside nuxt dev, takes the tunnel host for a mismatch', () => {
    configure(TUNNEL_URL)
    // `import.meta.dev` exists only in Nuxt's build, so vitest sees no such property (the production behaviour).
    expect((import.meta as ImportMeta & { dev?: boolean }).dev).toBeFalsy()
    expect(classifyRequest(event('tunnel.example.org', undefined))).toBe('mismatch')
    expect(classifyRequest(event('scantor.example.com', undefined))).toBe('public')
    expect(peerChecks).toEqual([])
  })
})

describe('the MCP loopback listener', () => {
  afterEach(async () => {
    await closeLoopbackListener()
    setLoopbackHandler(null)
  })

  /** Sends a request with the tunnel host to the loopback listener, whose handler answers with the classification. */
  async function classifyOnLoopback(): Promise<string> {
    setLoopbackHandler((req, res) => {
      const classified = classifyRequest({ node: { req, res }, context: {} } as unknown as H3Event)
      res.setHeader('content-type', 'text/plain')
      res.end(classified)
    })
    const { port } = new URL(await useLoopbackOrigin())
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/auth/jwks', headers: { host: 'tunnel.example.org' } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('is always public, even from the tunnel peer with the tunnel host', async () => {
    configure(TUNNEL_URL)
    tunnelPeers.add('127.0.0.1')
    expect(await classifyOnLoopback()).toBe('public')
    expect(peerChecks).toEqual([])
  })
})

describe('originUrlOf', () => {
  it('is the URL of the origin, and the tunnel origin needs SCANTOR_TUNNEL_URL', () => {
    expect(originUrlOf({ publicUrl: PUBLIC_URL, tunnelUrl: TUNNEL_URL }, 'public')).toBe(PUBLIC_URL)
    expect(originUrlOf({ publicUrl: PUBLIC_URL, tunnelUrl: TUNNEL_URL }, 'tunnel')).toBe(TUNNEL_URL)
    expect(originUrlOf({ publicUrl: PUBLIC_URL, tunnelUrl: null }, 'public')).toBe(PUBLIC_URL)
    expect(() => originUrlOf({ publicUrl: PUBLIC_URL, tunnelUrl: null }, 'tunnel')).toThrow('SCANTOR_TUNNEL_URL')
  })
})
