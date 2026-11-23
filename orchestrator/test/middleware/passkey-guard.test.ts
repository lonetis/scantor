import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, send, setResponseStatus, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The passkey guard per origin (docs/auth.md §2.2, §6.4; security.md TUN-4): the session of a passkey registration is
// read by the better-auth instance of the request's origin, which knows that origin's cookie name. With an http public
// URL next to the https tunnel URL the two names differ (`scantor.session_token`, `__Secure-scantor.session_token`), so
// reading a tunnel session on the public instance would find none and refuse the registration.

const tunnelPeers = new Set<string>()
const strip = (peer: string) => peer.replace(/^::ffff:/, '')
/** The origin of every instance asked for a session, with the cookie it got. */
const sessionReads: { origin: unknown; cookie: string | null }[] = []

vi.mock('../../server/utils/trusted-proxy', () => ({
  proxyTrust: () => (peer: string) => tunnelPeers.has(strip(peer)),
  useTrustedProxies: () => ({ isHostPeer: (host: string, peer: string) => host === 'cloudflared' && tunnelPeers.has(strip(peer)) }),
}))
vi.mock('../../server/utils/auth', () => ({
  // Each instance knows only the session cookie of its own origin (http public URL, https tunnel URL).
  useAuth: (origin: 'public' | 'tunnel' = 'public') => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const cookie = headers.get('cookie')
        sessionReads.push({ origin, cookie })
        const name = origin === 'tunnel' ? '__Secure-scantor.session_token' : 'scantor.session_token'
        return cookie === `${name}=valid` ? { session: { createdAt: new Date() }, user: { id: 'user-1' } } : null
      },
    },
  }),
}))
vi.mock('../../server/utils/users', () => ({ credentialSummary: async () => ({ hasPassword: true, passkeyCount: 1 }) }))

const { default: passkeyGuard } = await import('../../server/middleware/11.passkey-guard')
const { parseConfig, setConfigForTesting } = await import('../../server/utils/config')
const { normalizeError } = await import('../../server/utils/errors')

const TUNNEL_HOST = 'tunnel.example.org'

let server: Server | null = null
let port = 0

beforeEach(async () => {
  tunnelPeers.clear()
  sessionReads.length = 0
  setConfigForTesting(
    parseConfig({
      SCANTOR_PUBLIC_URL: 'http://scantor.example.com',
      SCANTOR_EDITOR_URL: 'http://editor.example.com',
      SCANTOR_TUNNEL_URL: `https://${TUNNEL_HOST}`,
    }).config,
  )
  const app = createApp({
    onError: (error, event) => {
      const normalized = normalizeError(error)
      setResponseStatus(event, normalized.status)
      return send(event, JSON.stringify(normalized.body), 'application/json')
    },
  })
  app.use(passkeyGuard)
  app.use(defineEventHandler(() => ({ passed: true })))
  server = createServer(toNodeListener(app))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  setConfigForTesting(null)
})

/** GET generate-register-options with a cookie, through the tunnel (cloudflared, tunnel host) or on the public URL. */
function registerOptions(through: 'public' | 'tunnel', cookie: string): Promise<{ status: number; body: string }> {
  if (through === 'tunnel') tunnelPeers.add('127.0.0.1')
  return new Promise((resolve, reject) => {
    const host = through === 'tunnel' ? TUNNEL_HOST : 'scantor.example.com'
    const req = request({ host: '127.0.0.1', port, path: '/api/auth/passkey/generate-register-options', headers: { host, cookie } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('the passkey guard per origin', () => {
  it('reads a tunnel request’s session on the tunnel instance, which knows its __Secure- cookie', async () => {
    const answer = await registerOptions('tunnel', '__Secure-scantor.session_token=valid')
    expect(answer.status, answer.body).toBe(200)
    expect(sessionReads).toEqual([{ origin: 'tunnel', cookie: '__Secure-scantor.session_token=valid' }])
  })

  it('reads a public request’s session on the public instance', async () => {
    const answer = await registerOptions('public', 'scantor.session_token=valid')
    expect(answer.status, answer.body).toBe(200)
    expect(sessionReads).toEqual([{ origin: 'public', cookie: 'scantor.session_token=valid' }])
  })

  it('takes a session cookie of the other origin for none (sign in to register)', async () => {
    const answer = await registerOptions('tunnel', 'scantor.session_token=valid')
    expect(answer.status).toBe(401)
    expect(JSON.parse(answer.body).error.message).toBe('sign in to register a passkey')
    expect(sessionReads).toEqual([{ origin: 'tunnel', cookie: 'scantor.session_token=valid' }])
  })
})
