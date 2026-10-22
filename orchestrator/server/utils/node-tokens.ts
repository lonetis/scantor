import { randomBytes } from 'node:crypto'
import type { NodeDoc } from '../types/documents'
import { NODE_TOKEN_PATTERN, NODE_TOKEN_PREFIX, nodeTokenHash } from './keys'
import { useCollections } from './mongo'
import type { NodePrincipal } from './principal'

// Node tokens (docs/auth.md §10.1): `snt_` + base64url(32 random bytes), stored only as the lowercase hex SHA-256
// of the full token. Positive lookups are cached 10 s by hash; rotate, revoke and delete clear the cache.

export const NODE_TOKEN_CACHE_MS = 10_000

export interface GeneratedNodeToken {
  token: string
  tokenHash: string
  /** first 8 characters, for display (`snt_ab12`) */
  tokenPrefix: string
}

export function generateNodeToken(): GeneratedNodeToken {
  const token = `${NODE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  return { token, tokenHash: nodeTokenHash(token), tokenPrefix: token.slice(0, 8) }
}

type NodeLookup = Pick<NodeDoc, '_id' | 'name' | 'builtIn' | 'endpointProfile' | 'pool' | 'state'>

const cache = new Map<string, { node: NodeLookup; expiresAt: number }>()

/** Resolves a node token to its node principal, or null when unknown, malformed or revoked. */
export async function resolveNodeToken(token: string, now = Date.now()): Promise<NodePrincipal | null> {
  if (!NODE_TOKEN_PATTERN.test(token)) return null
  const hash = nodeTokenHash(token)
  const cached = cache.get(hash)
  let node: NodeLookup | null = cached && cached.expiresAt > now ? cached.node : null
  if (!node) {
    node = await useCollections().nodes.findOne(
      { tokenHash: hash },
      { projection: { _id: 1, name: 1, builtIn: 1, endpointProfile: 1, pool: 1, state: 1 } },
    )
    if (!node || node.state === 'revoked') return null
    cache.set(hash, { node, expiresAt: now + NODE_TOKEN_CACHE_MS })
  }
  return {
    kind: 'node',
    node: { id: node._id, name: node.name, builtIn: node.builtIn, endpointProfile: node.endpointProfile, pool: node.pool },
  }
}

/** Clears cached lookups (call after rotate, revoke or delete). */
export function invalidateNodeTokenCache(): void {
  cache.clear()
}
