import { isIP } from 'node:net'
import { stripIpv4Mapped } from './internal-auth'
import type { ProxyTrust } from './trusted-proxy'

// Client IP (docs/auth.md §4.3): the socket peer, or, when that peer is a trusted proxy (utils/trusted-proxy.ts),
// the rightmost X-Forwarded-For entry (the address the proxy saw). Handed to better-auth through
// x-scantor-client-ip, which clients cannot inject because middleware/00.request.ts replaces any incoming value.

export const CLIENT_IP_HEADER = 'x-scantor-client-ip'

export function computeClientIp(
  peerAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  isTrustedProxy: ProxyTrust,
): string {
  const peer = peerAddress ? stripIpv4Mapped(peerAddress) : 'unknown'
  if (!forwardedFor || !peerAddress || !isTrustedProxy(peer)) return peer
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
  const rightmost = header
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1)
  return rightmost && isIP(stripIpv4Mapped(rightmost)) !== 0 ? stripIpv4Mapped(rightmost) : peer
}

/** Host header comparison key: lowercase host with the scheme's default port removed. */
export function normalizeHost(host: string, protocol: 'http:' | 'https:'): string {
  const lower = host.trim().toLowerCase()
  const defaultPort = protocol === 'https:' ? ':443' : ':80'
  return lower.endsWith(defaultPort) ? lower.slice(0, -defaultPort.length) : lower
}
