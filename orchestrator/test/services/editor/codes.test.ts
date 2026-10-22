import { describe, expect, it } from 'vitest'
import { EDITOR_CODE_PATTERN, EDITOR_CODE_TTL_MS, EditorCodeStore, FailureLimiter } from '../../../server/services/editor/codes'

// One-time codes of the editor handoff (docs/editor.md §8.3, docs/auth.md §12) and the /_auth failure limit (§8.2).

const USER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const OTHER = '1b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'

describe('EditorCodeStore', () => {
  it('issues sec_ + base64url(32 bytes) codes that expire after 60 s', () => {
    const store = new EditorCodeStore()
    const { code, expiresAt } = store.issue(USER, 'echo', 1_000)
    expect(code).toMatch(/^sec_[A-Za-z0-9_-]{43}$/)
    expect(code).toMatch(EDITOR_CODE_PATTERN)
    expect(Buffer.from(code.slice(4), 'base64url')).toHaveLength(32)
    expect(expiresAt.getTime()).toBe(1_000 + EDITOR_CODE_TTL_MS)
    expect(EDITOR_CODE_TTL_MS).toBe(60_000)
  })

  it('issues distinct codes', () => {
    const store = new EditorCodeStore()
    const codes = new Set(Array.from({ length: 100 }, () => store.issue(USER, null).code))
    expect(codes.size).toBe(100)
  })

  it('redeems a code once', () => {
    const store = new EditorCodeStore()
    const { code } = store.issue(USER, 'echo', 0)
    expect(store.consume(code, 1)).toEqual({ userId: USER, open: 'echo', expiresAt: EDITOR_CODE_TTL_MS })
    expect(store.consume(code, 2)).toBeNull()
  })

  it('rejects expired, unknown and malformed codes; an expired code is gone after the attempt', () => {
    const store = new EditorCodeStore()
    const { code } = store.issue(USER, null, 0)
    expect(store.consume(code, EDITOR_CODE_TTL_MS)).toBeNull()
    expect(store.size).toBe(0)
    expect(store.consume(`sec_${'A'.repeat(43)}`)).toBeNull()
    expect(store.consume('not-a-code')).toBeNull()
    expect(store.consume('')).toBeNull()
  })

  it('revokes every code of a user', () => {
    const store = new EditorCodeStore()
    const mine = store.issue(USER, null).code
    const theirs = store.issue(OTHER, null).code
    store.revokeUser(USER)
    expect(store.consume(mine)).toBeNull()
    expect(store.consume(theirs)?.userId).toBe(OTHER)
  })

  it('sweeps expired codes', () => {
    const store = new EditorCodeStore()
    store.issue(USER, null, 0)
    store.issue(USER, null, 30_000)
    expect(store.sweep(EDITOR_CODE_TTL_MS)).toBe(1)
    expect(store.size).toBe(1)
  })
})

describe('FailureLimiter', () => {
  it('blocks a client after 30 failures within a minute and forgets them after the window', () => {
    const limiter = new FailureLimiter()
    for (let i = 0; i < 29; i++) limiter.recordFailure('203.0.113.7', 1_000 + i)
    expect(limiter.isBlocked('203.0.113.7', 2_000)).toBe(false)
    limiter.recordFailure('203.0.113.7', 2_000)
    expect(limiter.isBlocked('203.0.113.7', 2_001)).toBe(true)
    expect(limiter.isBlocked('198.51.100.1', 2_001)).toBe(false)
    expect(limiter.isBlocked('203.0.113.7', 61_029)).toBe(false)
  })

  it('sweeps idle clients', () => {
    const limiter = new FailureLimiter(2, 1_000)
    limiter.recordFailure('a', 0)
    limiter.recordFailure('a', 1)
    expect(limiter.isBlocked('a', 500)).toBe(true)
    limiter.sweep(5_000)
    expect(limiter.isBlocked('a', 5_000)).toBe(false)
  })
})
