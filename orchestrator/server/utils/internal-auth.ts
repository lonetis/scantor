import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isLoopbackListenerSocket } from './loopback'
import { isLoopbackAddress } from './startup-guard'
import type { UserPrincipal } from './principal'

// Single-use internal capabilities `sic_…` (docs/auth.md §5.2, docs/mcp.md §4.3): the MCP bridge mints one per tool
// call, bound to one method, pathname and operation, valid 60 s, accepted only on the loopback listener of this
// process (server/utils/loopback.ts) from a loopback peer, and deleted on first use. They live in memory: the
// loopback listener always serves this process.

export const INTERNAL_AUTH_HEADER = 'x-scantor-internal-auth'
export const INTERNAL_CAPABILITY_TTL_MS = 60_000

export interface InternalCapability {
  /** the principal snapshot the request will run as (via `mcp`) */
  principal: UserPrincipal
  method: string
  pathname: string
  operationId: string
  expiresAt: number
}

const capabilities = new Map<string, InternalCapability>()

function sweep(now: number): void {
  for (const [token, capability] of capabilities) if (capability.expiresAt <= now) capabilities.delete(token)
}

export function mintInternalCapability(input: Omit<InternalCapability, 'expiresAt'>, now = Date.now()): string {
  sweep(now)
  const token = `sic_${randomBytes(32).toString('base64url')}`
  capabilities.set(token, { ...input, method: input.method.toUpperCase(), expiresAt: now + INTERNAL_CAPABILITY_TTL_MS })
  return token
}

/** The facts of a request a capability is checked against. */
export interface CapabilityRequest {
  method: string
  pathname: string
  peerAddress: string | undefined
  /** the request arrived on the loopback listener (server/utils/loopback.ts) */
  viaLoopbackListener: boolean
}

export function capabilityRequestOf(req: IncomingMessage, pathname: string): CapabilityRequest {
  return {
    method: req.method ?? 'GET',
    pathname,
    peerAddress: req.socket.remoteAddress,
    viaLoopbackListener: isLoopbackListenerSocket(req.socket),
  }
}

/**
 * Consumes a capability: it must exist, be unexpired, match the request method and pathname, and arrive on the
 * loopback listener from a loopback peer. The entry is deleted on first use, whatever the outcome.
 */
export function consumeInternalCapability(token: string, request: CapabilityRequest, now = Date.now()): InternalCapability | null {
  const capability = capabilities.get(token)
  if (!capability) return null
  capabilities.delete(token)
  if (capability.expiresAt <= now) return null
  if (!request.viaLoopbackListener) return null
  if (!request.peerAddress || !isLoopbackAddress(stripIpv4Mapped(request.peerAddress))) return null
  if (capability.method !== request.method.toUpperCase() || capability.pathname !== request.pathname) return null
  return capability
}

/** `::ffff:127.0.0.1` → `127.0.0.1` (Node reports IPv4 peers of dual-stack sockets in mapped form). */
export function stripIpv4Mapped(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address
}
