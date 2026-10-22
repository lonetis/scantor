import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { mintToolsJwt, TOOLS_COOKIE_TTL_S, toolsCookieHeader, type ToolsSigner, verifyToolsJwt } from '../../../server/services/tools/cookie'
import { createKeyring } from '../../../server/utils/keys'
import { readRepoFile } from '../../helpers/repo'

// The `scantor_tools` JWT (docs/auth.md §11) against the shared signature vectors of tests/corpora/keys-vectors.json.

interface SignatureVector {
  secret: string
  signingInput: string
  signature: string
}

const vectors = (JSON.parse(readRepoFile('tests/corpora/keys-vectors.json')) as { toolsCookieSignature: SignatureVector[] }).toolsCookieSignature
const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const IAT = 1_761_040_800

function signerOf(secret: string): ToolsSigner {
  const keyring = createKeyring(secret)
  return (signingInput) => keyring.toolsCookieSignature(signingInput)
}

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** A JWT with arbitrary header and claims, signed with the HS256 tools key of `secret`. */
function forge(header: unknown, claims: unknown, secret = 'correct horse battery staple'): string {
  const input = `${segment(header)}.${segment(claims)}`
  return `${input}.${signerOf(secret)(input)}`
}

const goodClaims = { iss: 'scantor', aud: 'tools', sub: USER_ID, role: 'admin', iat: IAT, exp: IAT + 28_800, jti: 'x' }

describe('tools cookie JWT', () => {
  it('mints exactly the shared vectors (header, claim order, HS256 signature)', () => {
    for (const vector of vectors) {
      const { token } = mintToolsJwt(USER_ID, signerOf(vector.secret), { nowMs: IAT * 1000, jti: '8c1f6d0e-2a3b-4c5d-8e9f-0a1b2c3d4e5f' })
      expect(token).toBe(`${vector.signingInput}.${vector.signature}`)
    }
  })

  it('signs with HMAC-SHA256 of key("tools-cookie")', () => {
    const vector = vectors[0]!
    const key = createKeyring(vector.secret).derive('tools-cookie')
    expect(createHmac('sha256', key).update(vector.signingInput).digest('base64url')).toBe(vector.signature)
  })

  it('verifies a fresh token and rejects it with another key', () => {
    const sign = signerOf('s1')
    const { token, claims } = mintToolsJwt(USER_ID, sign, { nowMs: IAT * 1000 })
    expect(claims.exp - claims.iat).toBe(TOOLS_COOKIE_TTL_S)
    expect(verifyToolsJwt(token, sign, IAT * 1000)).toEqual(claims)
    expect(verifyToolsJwt(token, signerOf('s2'), IAT * 1000)).toBeNull()
  })

  it('allows 30 s of leeway after exp and no more', () => {
    const sign = signerOf('s1')
    const { token, claims } = mintToolsJwt(USER_ID, sign, { nowMs: IAT * 1000 })
    expect(verifyToolsJwt(token, sign, (claims.exp + 29) * 1000)).not.toBeNull()
    expect(verifyToolsJwt(token, sign, (claims.exp + 30) * 1000)).toBeNull()
  })

  it('pins the algorithm: none, HS512 and RS256 headers are rejected', () => {
    const now = IAT * 1000
    const secret = 'correct horse battery staple'
    const sign = signerOf(secret)
    expect(verifyToolsJwt(forge({ alg: 'HS256', typ: 'JWT' }, goodClaims), sign, now)).not.toBeNull()
    expect(verifyToolsJwt(`${segment({ alg: 'none' })}.${segment(goodClaims)}.`, sign, now)).toBeNull()
    expect(verifyToolsJwt(forge({ alg: 'HS512', typ: 'JWT' }, goodClaims), sign, now)).toBeNull()
    expect(verifyToolsJwt(forge({ alg: 'RS256' }, goodClaims), sign, now)).toBeNull()
    expect(verifyToolsJwt(forge({ alg: 'HS256', typ: 'JWS' }, goodClaims), sign, now)).toBeNull()
  })

  it('checks issuer, audience, subject and role', () => {
    const now = IAT * 1000
    const sign = signerOf('correct horse battery staple')
    const header = { alg: 'HS256', typ: 'JWT' }
    expect(verifyToolsJwt(forge(header, { ...goodClaims, iss: 'other' }), sign, now)).toBeNull()
    expect(verifyToolsJwt(forge(header, { ...goodClaims, aud: 'scantor-registry' }), sign, now)).toBeNull()
    expect(verifyToolsJwt(forge(header, { ...goodClaims, aud: ['tools'] }), sign, now)).toBeNull()
    expect(verifyToolsJwt(forge(header, { ...goodClaims, sub: 'admin' }), sign, now)).toBeNull()
    expect(verifyToolsJwt(forge(header, { ...goodClaims, role: 'user' }), sign, now)).toBeNull()
    expect(verifyToolsJwt(forge(header, { ...goodClaims, exp: 'later' }), sign, now)).toBeNull()
  })

  it('rejects malformed tokens', () => {
    const sign = signerOf('s1')
    for (const bad of ['', 'a.b', 'a.b.c.d', '!!.!!.!!', `${segment({ alg: 'HS256' })}.not-json.sig`]) expect(verifyToolsJwt(bad, sign)).toBeNull()
  })

  it('builds the cookie for the Traefik domain', () => {
    expect(toolsCookieHeader('jwt', 'scantor.example')).toBe(
      'scantor_tools=jwt; Domain=scantor.example; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax',
    )
  })
})
