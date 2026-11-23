import { describe, expect, it } from 'vitest'
import { computeClientIp, normalizeHost } from '../../server/utils/client-ip'
import { TrustedProxies } from '../../server/utils/trusted-proxy'
import { useLogger } from '../../server/utils/logger'

// Client IP for rate limits and logs (docs/auth.md §4.3, security.md AUTH-6).

const TRAEFIK = '172.18.0.5'
const traefikOnly = (peer: string) => peer === TRAEFIK

describe('computeClientIp', () => {
  it('uses the socket peer when no proxy is trusted', () => {
    expect(computeClientIp('::ffff:10.0.0.9', '1.2.3.4', () => false)).toBe('10.0.0.9')
    expect(computeClientIp(undefined, undefined, () => false)).toBe('unknown')
    expect(computeClientIp(undefined, '1.2.3.4', () => true)).toBe('unknown')
  })

  it('takes the rightmost X-Forwarded-For entry only when the peer is the trusted proxy', () => {
    expect(computeClientIp(TRAEFIK, 'spoofed, 203.0.113.7', traefikOnly)).toBe('203.0.113.7')
    expect(computeClientIp(`::ffff:${TRAEFIK}`, ['a', '198.51.100.2'], traefikOnly)).toBe('198.51.100.2')
    expect(computeClientIp(TRAEFIK, undefined, traefikOnly)).toBe(TRAEFIK)
    expect(computeClientIp(TRAEFIK, 'garbage', traefikOnly)).toBe(TRAEFIK)
  })

  it('ignores X-Forwarded-For from any other peer, such as a sandbox container', () => {
    expect(computeClientIp('10.10.2.7', '198.51.100.9', traefikOnly)).toBe('10.10.2.7')
    expect(computeClientIp('::ffff:10.10.2.7', ['203.0.113.1', '203.0.113.2'], traefikOnly)).toBe('10.10.2.7')
  })
})

describe('computeClientIp through the Cloudflare Tunnel (security.md TUN-3)', () => {
  it('takes the rightmost entry from cloudflared, the address the edge of Cloudflare saw', async () => {
    const CLOUDFLARED = '172.18.0.9'
    const proxies = new TrustedProxies(
      ['cloudflared'],
      // cloudflared on the network scantor-tunnel, which the orchestrator is attached to
      { resolve: async () => [CLOUDFLARED], untrustedSubnets: async () => ['10.10.2.0/24'], attachedSubnets: () => ['172.18.0.0/16'] },
      useLogger('test'),
    )
    await proxies.refresh()
    expect(computeClientIp(CLOUDFLARED, '198.51.100.66, 203.0.113.7', proxies.isTrusted)).toBe('203.0.113.7')
    expect(computeClientIp(`::ffff:${CLOUDFLARED}`, ['198.51.100.66', '203.0.113.8'], proxies.isTrusted)).toBe('203.0.113.8')
    // Any other peer is the client itself, whatever it forwards.
    expect(computeClientIp('10.10.2.7', '203.0.113.7', proxies.isTrusted)).toBe('10.10.2.7')
  })
})

describe('normalizeHost', () => {
  it('lowercases and drops the default port', () => {
    expect(normalizeHost('Editor.Example.com:443', 'https:')).toBe('editor.example.com')
    expect(normalizeHost('localhost:3001', 'http:')).toBe('localhost:3001')
    expect(normalizeHost('example.com:80', 'http:')).toBe('example.com')
  })

  it('compares the tunnel host with and without its port (docs/auth.md §4.5)', () => {
    expect(normalizeHost('Tunnel.Example.org:443', 'https:')).toBe(new URL('https://tunnel.example.org').host)
    expect(normalizeHost('tunnel.example.org', 'https:')).toBe('tunnel.example.org')
    expect(normalizeHost('tunnel.scantor.localhost:8443', 'https:')).toBe(new URL('https://tunnel.scantor.localhost:8443').host)
    expect(normalizeHost('tunnel.example.org:80', 'https:')).toBe('tunnel.example.org:80')
  })
})
