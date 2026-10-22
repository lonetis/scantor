import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { REGISTRY_TOKEN_TTL_SECONDS, registryJwks } from '../../../server/services/registry/jwt'
import {
  getTokenRequest,
  issueRegistryToken,
  parseBasicAuth,
  postTokenRequest,
  type RegistryTokenDeps,
} from '../../../server/services/registry/token'
import { createKeyring } from '../../../server/utils/keys'

// The registry token server (docs/api.md §6, docs/auth.md §10.4, docs/nodes.md §10.1): GET + Basic and POST form
// flows, ES256 JWTs verifiable with the JWKS the registry reads, grants per credential, registry error format.

const keys = createKeyring('registry token unit test secret')
const NODE_1 = '2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'
const NODE_TOKEN = `snt_${'A'.repeat(43)}`
const REVOKED_TOKEN = `snt_${'B'.repeat(43)}`
const TASK_A = 'tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
const TASK_B = 'tasks/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const NOW = Date.parse('2026-10-21T10:00:00.000Z')

const deps: RegistryTokenDeps = {
  signingKey: () => keys.registrySigningKey(),
  orchestratorPassword: () => keys.registryPushPassword(),
  nodeOf: async (token) => (token === NODE_TOKEN ? NODE_1 : null),
  nodeRepositories: async (nodeId) => new Set(nodeId === NODE_1 ? [TASK_A] : []),
  now: () => NOW,
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

interface Decoded {
  header: Record<string, unknown>
  claims: Record<string, unknown> & { access: { type: string; name: string; actions: string[] }[] }
}

/** Verifies an ES256 compact JWS with the public JWK of the JWKS document and decodes it. */
function verifyToken(token: string): Decoded {
  const [header, payload, signature] = token.split('.')
  const jwks = registryJwks(keys.registrySigningKey())
  const decodedHeader = JSON.parse(Buffer.from(header!, 'base64url').toString('utf8')) as Record<string, unknown>
  const jwk = jwks.keys.find((key) => key.kid === decodedHeader.kid)
  expect(jwk, 'the token kid is in the JWKS').toBeDefined()
  const publicKey = createPublicKey({ key: { kty: jwk!.kty, crv: jwk!.crv, x: jwk!.x, y: jwk!.y }, format: 'jwk' })
  const valid = verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))
  expect(valid, 'ES256 signature').toBe(true)
  return { header: decodedHeader, claims: JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Decoded['claims'] }
}

function getRequest(authorization: string | null, query: string) {
  return getTokenRequest(authorization, new URLSearchParams(query))
}

describe('Basic credentials', () => {
  it('parses Basic headers', () => {
    expect(parseBasicAuth(basic('node', NODE_TOKEN))).toEqual({ username: 'node', password: NODE_TOKEN })
    expect(parseBasicAuth(basic('orchestrator', 'a:b'))).toEqual({ username: 'orchestrator', password: 'a:b' })
    expect(parseBasicAuth(null)).toBeNull()
    expect(parseBasicAuth('Bearer x')).toBeNull()
    expect(parseBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeNull()
  })
})

describe('GET flow', () => {
  it('issues a node token with pull on its assigned repository only', async () => {
    const outcome = await issueRegistryToken(
      getRequest(basic('node', NODE_TOKEN), `service=scantor-registry&scope=repository:${TASK_A}:pull&scope=repository:${TASK_B}:pull&account=node&client_id=docker&offline_token=true`),
      deps,
    )
    expect(outcome.status).toBe(200)
    if (outcome.status !== 200) return
    expect(outcome.body.token).toBe(outcome.body.access_token)
    expect(outcome.body.expires_in).toBe(REGISTRY_TOKEN_TTL_SECONDS)
    expect(outcome.body.issued_at).toBe('2026-10-21T10:00:00Z')
    const { header, claims } = verifyToken(String(outcome.body.token))
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: keys.registrySigningKey().kid })
    expect(claims).toMatchObject({ iss: 'scantor', sub: `node:${NODE_1}`, aud: 'scantor-registry', iat: NOW / 1000, exp: NOW / 1000 + 300 })
    expect(claims.nbf).toBeLessThanOrEqual(claims.iat as number)
    expect(typeof claims.jti).toBe('string')
    expect(claims.access).toEqual([{ type: 'repository', name: TASK_A, actions: ['pull'] }])
  })

  it('never gives a node push, delete or the catalog', async () => {
    const outcome = await issueRegistryToken(getRequest(basic('node', NODE_TOKEN), `scope=repository:${TASK_A}:push,delete&scope=registry:catalog:*`), deps)
    expect(outcome.status).toBe(200)
    if (outcome.status !== 200) return
    expect(verifyToken(String(outcome.body.token)).claims.access).toEqual([])
  })

  it('answers a login without scope with an empty access list', async () => {
    const outcome = await issueRegistryToken(getRequest(basic('orchestrator', keys.registryPushPassword()), 'service=scantor-registry'), deps)
    expect(outcome.status).toBe(200)
    if (outcome.status !== 200) return
    const { claims } = verifyToken(String(outcome.body.token))
    expect(claims.sub).toBe('orchestrator')
    expect(claims.access).toEqual([])
  })

  it('gives the orchestrator credential push, pull, delete and the catalog', async () => {
    const outcome = await issueRegistryToken(
      getRequest(basic('orchestrator', keys.registryPushPassword()), `scope=repository:${TASK_B}:push,pull,delete&scope=registry:catalog:*&scope=repository:library/x:pull`),
      deps,
    )
    expect(outcome.status).toBe(200)
    if (outcome.status !== 200) return
    expect(verifyToken(String(outcome.body.token)).claims.access).toEqual([
      { type: 'repository', name: TASK_B, actions: ['push', 'pull', 'delete'] },
      { type: 'registry', name: 'catalog', actions: ['*'] },
    ])
  })

  it('refuses unknown, revoked and malformed credentials with the registry error format', async () => {
    for (const authorization of [null, basic('node', REVOKED_TOKEN), basic('orchestrator', 'wrong'), basic('admin', keys.registryPushPassword()), 'Basic !!!']) {
      const outcome = await issueRegistryToken(getRequest(authorization, `scope=repository:${TASK_A}:pull`), deps)
      expect(outcome.status, String(authorization)).toBe(401)
      expect(outcome.body).toEqual({ errors: [{ code: 'UNAUTHORIZED', message: expect.any(String) }] })
    }
  })

  it('refuses another service', async () => {
    const outcome = await issueRegistryToken(getRequest(basic('node', NODE_TOKEN), 'service=other'), deps)
    expect(outcome.status).toBe(400)
  })
})

describe('POST flow (OAuth2 password grant)', () => {
  it('issues access_token only, with space-separated scopes', async () => {
    const form = new URLSearchParams({
      grant_type: 'password',
      service: 'scantor-registry',
      client_id: 'containerd-client',
      username: 'node',
      password: NODE_TOKEN,
      scope: `repository:${TASK_A}:pull repository:${TASK_B}:pull`,
    })
    const outcome = await issueRegistryToken(postTokenRequest(null, form), deps)
    expect(outcome.status).toBe(200)
    if (outcome.status !== 200) return
    expect(outcome.body).not.toHaveProperty('token')
    expect(outcome.body).not.toHaveProperty('refresh_token')
    expect(outcome.body.expires_in).toBe(300)
    expect(verifyToken(String(outcome.body.access_token)).claims.access).toEqual([{ type: 'repository', name: TASK_A, actions: ['pull'] }])
  })

  it('accepts Basic credentials when the form has none', async () => {
    const outcome = await issueRegistryToken(postTokenRequest(basic('node', NODE_TOKEN), new URLSearchParams({ grant_type: 'password' })), deps)
    expect(outcome.status).toBe(200)
  })

  it('refuses other grant types and wrong passwords', async () => {
    const refresh = await issueRegistryToken(postTokenRequest(null, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x' })), deps)
    expect(refresh.status).toBe(400)
    const wrong = await issueRegistryToken(postTokenRequest(null, new URLSearchParams({ grant_type: 'password', username: 'node', password: REVOKED_TOKEN })), deps)
    expect(wrong.status).toBe(401)
  })
})

describe('JWKS', () => {
  it('publishes the public key of the signing key under its kid', () => {
    const signing = keys.registrySigningKey()
    expect(registryJwks(signing)).toEqual({ keys: [{ kty: 'EC', crv: 'P-256', x: signing.publicJwk.x, y: signing.publicJwk.y, kid: signing.kid, use: 'sig', alg: 'ES256' }] })
    expect(signing.kid).toMatch(/^scantor-[0-9a-f]{16}$/)
  })
})
