import { describe, expect, it } from 'vitest'
import { computeClientIp, normalizeHost } from '../../server/utils/client-ip'

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

describe('normalizeHost', () => {
  it('lowercases and drops the default port', () => {
    expect(normalizeHost('Editor.Example.com:443', 'https:')).toBe('editor.example.com')
    expect(normalizeHost('localhost:3001', 'http:')).toBe('localhost:3001')
    expect(normalizeHost('example.com:80', 'http:')).toBe('example.com')
  })
})
