import { describe, expect, it } from 'vitest'
import {
  type CapabilityRequest,
  consumeInternalCapability,
  INTERNAL_CAPABILITY_TTL_MS,
  mintInternalCapability,
  stripIpv4Mapped,
} from '../../server/utils/internal-auth'
import type { UserPrincipal } from '../../server/utils/principal'

// Single-use MCP capabilities `sic_…` (docs/auth.md §5.2, docs/mcp.md §4.3).

const principal: UserPrincipal = {
  kind: 'user',
  via: 'mcp',
  user: { id: 'u', email: 'u@x', name: 'u', role: 'user' },
  isAdmin: false,
  mcp: { clientId: 'c', level: 'read', operationId: 'getScan' },
}

function mint(now = 1000) {
  return mintInternalCapability({ principal, method: 'get', pathname: '/api/scans/s', operationId: 'getScan' }, now)
}

describe('internal capabilities', () => {
  it('has the documented token shape', () => {
    expect(mint()).toMatch(/^sic_[A-Za-z0-9_-]{43}$/)
  })

  const valid: CapabilityRequest = { method: 'GET', pathname: '/api/scans/s', peerAddress: '127.0.0.1', viaLoopbackListener: true }

  it('is accepted once, on the loopback listener from loopback, for the bound method and path', () => {
    const token = mint()
    const request = { ...valid, peerAddress: '::ffff:127.0.0.1' }
    expect(consumeInternalCapability(token, request, 2000)?.operationId).toBe('getScan')
    expect(consumeInternalCapability(token, request, 2000)).toBeNull()
  })

  it.each([
    ['another method', { ...valid, method: 'POST' }],
    ['another path', { ...valid, pathname: '/api/scans/t' }],
    ['a remote peer', { ...valid, peerAddress: '10.0.0.5' }],
    ['no peer', { ...valid, peerAddress: undefined }],
    ['the public listener', { ...valid, viaLoopbackListener: false }],
  ])('is rejected (and burned) for %s', (_name, request) => {
    const token = mint()
    expect(consumeInternalCapability(token, request, 2000)).toBeNull()
    expect(consumeInternalCapability(token, valid, 2000)).toBeNull()
  })

  it('expires after 60 s', () => {
    const token = mint(0)
    expect(consumeInternalCapability(token, { ...valid, peerAddress: '::1' }, INTERNAL_CAPABILITY_TTL_MS)).toBeNull()
  })

  it('normalises IPv4-mapped addresses', () => {
    expect(stripIpv4Mapped('::ffff:10.0.0.1')).toBe('10.0.0.1')
    expect(stripIpv4Mapped('::1')).toBe('::1')
  })
})
