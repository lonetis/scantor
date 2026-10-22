import { describe, expect, it } from 'vitest'
import {
  cookieValues,
  EDITOR_COOKIE_TTL_MS,
  editorCookieHeader,
  type EditorCookieSigner,
  verifyEditorCookie,
} from '../../../server/services/editor/cookie'
import { createKeyring } from '../../../server/utils/keys'
import { readRepoFile } from '../../helpers/repo'

// The `scantor_editor` cookie format (docs/editor.md §8.4, docs/auth.md §12) against the shared vectors that Go
// internal/keys produces (tests/corpora/keys-vectors.json).

interface CookieVector {
  secret: string
  userId: string
  editorStartedAtMs: number
  expiresAtMs: number
  value: string
}

const vectors = (JSON.parse(readRepoFile('tests/corpora/keys-vectors.json')) as { editorCookie: CookieVector[] }).editorCookie

function signerOf(secret: string): EditorCookieSigner {
  const keyring = createKeyring(secret)
  return (userId, startedAtMs, expiresAtMs) => keyring.editorCookie(userId, startedAtMs, expiresAtMs)
}

describe('editor cookie', () => {
  it('signs exactly the shared vectors and verifies them', () => {
    expect(vectors.length).toBeGreaterThan(0)
    for (const vector of vectors) {
      const sign = signerOf(vector.secret)
      expect(sign(vector.userId, vector.editorStartedAtMs, vector.expiresAtMs)).toBe(vector.value)
      expect(verifyEditorCookie(vector.value, sign, vector.expiresAtMs - 1)).toEqual({
        userId: vector.userId,
        editorStartedAtMs: vector.editorStartedAtMs,
        expiresAtMs: vector.expiresAtMs,
      })
    }
  })

  it('has the documented shape v1.<userId>.<startedAtMs>.<expiresAtMs>.<mac>', () => {
    const value = vectors[0]!.value
    expect(value).toMatch(/^v1\.[0-9a-f-]{36}\.\d+\.\d+\.[A-Za-z0-9_-]{43}$/)
  })

  it('rejects another secret, tampered fields and a tampered MAC', () => {
    const vector = vectors[0]!
    const sign = signerOf(vector.secret)
    const now = vector.expiresAtMs - 1000
    expect(verifyEditorCookie(vector.value, signerOf('another secret'), now)).toBeNull()
    expect(verifyEditorCookie(vector.value.replace(`.${vector.editorStartedAtMs}.`, `.${vector.editorStartedAtMs + 1}.`), sign, now)).toBeNull()
    expect(verifyEditorCookie(vector.value.replace(`.${vector.expiresAtMs}.`, `.${vector.expiresAtMs + 3_600_000}.`), sign, now)).toBeNull()
    const otherUser = vector.value.replace(vector.userId, '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11')
    expect(verifyEditorCookie(otherUser, sign, now)).toBeNull()
    const mac = vector.value.slice(-43)
    const flipped = vector.value.slice(0, -43) + (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)
    expect(verifyEditorCookie(flipped, sign, now)).toBeNull()
  })

  it('rejects expired cookies and malformed values', () => {
    const vector = vectors[0]!
    const sign = signerOf(vector.secret)
    expect(verifyEditorCookie(vector.value, sign, vector.expiresAtMs)).toBeNull()
    expect(verifyEditorCookie(vector.value, sign, vector.expiresAtMs + 1)).toBeNull()
    for (const bad of ['', 'v1', `v2${vector.value.slice(2)}`, `${vector.value}.x`, vector.value.toUpperCase(), ` ${vector.value}`]) {
      expect(verifyEditorCookie(bad, sign, 0)).toBeNull()
    }
  })

  it('sets host-only, HttpOnly, Lax cookies for 12 h; Secure only on https', () => {
    expect(EDITOR_COOKIE_TTL_MS).toBe(43_200_000)
    expect(editorCookieHeader('v1.x', false)).toBe('scantor_editor=v1.x; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax')
    expect(editorCookieHeader('v1.x', true)).toBe('scantor_editor=v1.x; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure')
    expect(editorCookieHeader('v1.x', true)).not.toMatch(/Domain=/i)
  })

  it('reads every value of a cookie name in header order', () => {
    expect(cookieValues(undefined, 'scantor_editor')).toEqual([])
    expect(cookieValues('a=1; scantor_editor=one; b=2; scantor_editor=two', 'scantor_editor')).toEqual(['one', 'two'])
    expect(cookieValues(['x_scantor_editor=no', 'scantor_editor = spaced '], 'scantor_editor')).toEqual(['spaced'])
    expect(cookieValues('scantor.session_token=abc', 'scantor_editor')).toEqual([])
  })
})
