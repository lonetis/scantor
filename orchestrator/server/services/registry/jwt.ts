import { randomUUID, sign } from 'node:crypto'
import type { RegistrySigningKey } from '../../utils/keys'
import type { RegistryAccess } from './scopes'

// ES256 registry tokens (docs/api.md §6, docs/auth.md §10.4), signed with node:crypto and the HKDF-derived P-256 key
// of server/utils/keys.ts. The JWKS the registry reads holds the matching public key under the same `kid`.

export const REGISTRY_ISSUER = 'scantor'
export const REGISTRY_SERVICE = 'scantor-registry'
export const REGISTRY_TOKEN_TTL_SECONDS = 300
/** `nbf` lies slightly in the past so registries with a lagging clock accept fresh tokens. */
const NOT_BEFORE_SKEW_SECONDS = 10

export interface RegistryTokenClaims {
  iss: string
  sub: string
  aud: string
  iat: number
  nbf: number
  exp: number
  jti: string
  access: RegistryAccess[]
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function registryClaims(subject: string, access: RegistryAccess[], nowMs = Date.now(), jti: string = randomUUID()): RegistryTokenClaims {
  const iat = Math.floor(nowMs / 1000)
  return {
    iss: REGISTRY_ISSUER,
    sub: subject,
    aud: REGISTRY_SERVICE,
    iat,
    nbf: iat - NOT_BEFORE_SKEW_SECONDS,
    exp: iat + REGISTRY_TOKEN_TTL_SECONDS,
    jti,
    access,
  }
}

/** A compact JWS: header `{alg: "ES256", typ: "JWT", kid}`, the JOSE (IEEE P1363) signature encoding. */
export function signRegistryToken(claims: RegistryTokenClaims, key: RegistrySigningKey): string {
  const signingInput = `${b64urlJson({ alg: 'ES256', typ: 'JWT', kid: key.kid })}.${b64urlJson(claims)}`
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${signature.toString('base64url')}`
}

/** The JWKS document the registry reads (`REGISTRY_AUTH_TOKEN_JWKS`). */
export function registryJwks(key: RegistrySigningKey): { keys: Record<string, string>[] } {
  return { keys: [{ ...key.publicJwk, kid: key.kid, use: 'sig', alg: 'ES256' }] }
}
