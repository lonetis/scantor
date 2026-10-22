import type { NodeDoc } from '../../types/documents'

// The node instance lease (docs/nodes.md §5.2): one daemon instance at a time may act for a node. `instanceId` is
// "<Docker engine id>:<boot nonce>". A hello is granted when there is no lease, the lease is the caller's own or the
// lease has expired (no request for SCANTOR_NODE_OFFLINE_AFTER); a restarted daemon on the same engine takes the
// lease over at once; a live lease of a different engine is a 409 nodeInstanceConflict. Every later request must
// come from the lease holder.

export type NodeInstance = NonNullable<NodeDoc['instance']>

export type HelloLeaseDecision =
  | { kind: 'grant'; takeover: boolean }
  | { kind: 'conflict'; retryAfterMs: number }

/**
 * The engine part of an instance id. Older Docker engines used colon-separated ids, so the nonce is everything
 * after the last colon.
 */
export function engineIdOf(instanceId: string): string {
  const cut = instanceId.lastIndexOf(':')
  return cut > 0 ? instanceId.slice(0, cut) : instanceId
}

export function leaseRemainingMs(instance: NodeInstance, now: Date, offlineAfterMs: number): number {
  return Math.max(0, instance.lastSeenAt.getTime() + offlineAfterMs - now.getTime())
}

export function evaluateHelloLease(current: NodeInstance | null, instanceId: string, now: Date, offlineAfterMs: number): HelloLeaseDecision {
  if (!current || current.id === instanceId) return { kind: 'grant', takeover: false }
  if (leaseRemainingMs(current, now, offlineAfterMs) === 0) return { kind: 'grant', takeover: false }
  if (engineIdOf(current.id) === engineIdOf(instanceId)) return { kind: 'grant', takeover: true }
  return { kind: 'conflict', retryAfterMs: leaseRemainingMs(current, now, offlineAfterMs) }
}

export type LeaseHolderCheck = { ok: true } | { ok: false; retryAfterMs: number }

/** Requests after hello must come from the lease holder; anyone else goes back to hello. */
export function checkLeaseHolder(current: NodeInstance | null, instanceId: string | null | undefined, now: Date, offlineAfterMs: number): LeaseHolderCheck {
  if (current && instanceId && current.id === instanceId) return { ok: true }
  return { ok: false, retryAfterMs: current ? leaseRemainingMs(current, now, offlineAfterMs) : 0 }
}
