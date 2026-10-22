import { describe, expect, it } from 'vitest'
import { computeClientIp, normalizeHost } from '../../server/utils/client-ip'

// Client IP for rate limits and logs (docs/auth.md §4.3, security.md AUTH-6).

describe('computeClientIp', () => {
  it('uses the socket peer unless the proxy is trusted', () => {
    expect(computeClientIp('::ffff:10.0.0.9', '1.2.3.4', false)).toBe('10.0.0.9')
    expect(computeClientIp(undefined, undefined, false)).toBe('unknown')
  })

  it('takes the rightmost X-Forwarded-For entry behind the trusted proxy', () => {
    expect(computeClientIp('172.18.0.5', 'spoofed, 203.0.113.7', true)).toBe('203.0.113.7')
    expect(computeClientIp('172.18.0.5', ['a', '198.51.100.2'], true)).toBe('198.51.100.2')
    expect(computeClientIp('172.18.0.5', undefined, true)).toBe('172.18.0.5')
    expect(computeClientIp('172.18.0.5', 'garbage', true)).toBe('172.18.0.5')
  })
})

describe('normalizeHost', () => {
  it('lowercases and drops the default port', () => {
    expect(normalizeHost('Editor.Example.com:443', 'https:')).toBe('editor.example.com')
    expect(normalizeHost('localhost:3001', 'http:')).toBe('localhost:3001')
    expect(normalizeHost('example.com:80', 'http:')).toBe('example.com')
  })
})
