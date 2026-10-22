import { describe, expect, it } from 'vitest'
import { EditorCodeStore } from '../../../server/services/editor/codes'
import { editorLandingPath, EditorSessions, type EditorStateSnapshot } from '../../../server/services/editor/sessions'
import { createKeyring } from '../../../server/utils/keys'
import type { CachedUser } from '../../../server/utils/user-cache'

// Cookie validation rules 1–4 and the code redemption of docs/editor.md §8.3–§8.4.

const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const STARTED_AT = new Date('2026-10-21T09:00:00.000Z')
const NOW = STARTED_AT.getTime() + 60_000

const keyring = createKeyring('sessions test secret')
const sign = (userId: string, startedAtMs: number, expiresAtMs: number) => keyring.editorCookie(userId, startedAtMs, expiresAtMs)
const activeUser: CachedUser = { id: USER_ID, email: 'a@example.com', name: 'A', role: 'user', banned: false, banExpires: null, canRunPrivileged: false, maxWorkers: 0 }

function setup(options: { user?: CachedUser | null; editor?: EditorStateSnapshot | null; stateTtlMs?: number } = {}) {
  const state = { editor: options.editor === undefined ? { state: 'running', startedAt: STARTED_AT } as EditorStateSnapshot : options.editor, loads: 0 }
  const codes = new EditorCodeStore()
  const sessions = new EditorSessions({
    sign,
    getUser: async () => (options.user === undefined ? activeUser : options.user),
    isBanned: (user) => user.banned,
    loadEditor: async () => {
      state.loads++
      return state.editor
    },
    codes,
    stateTtlMs: options.stateTtlMs,
  })
  return { sessions, codes, state }
}

const cookieFor = (startedAt = STARTED_AT, expiresAtMs = NOW + 3_600_000) => `scantor_editor=${sign(USER_ID, startedAt.getTime(), expiresAtMs)}`

describe('EditorSessions.check', () => {
  it('accepts a valid cookie of a running or starting editor', async () => {
    expect(await setup().sessions.check(cookieFor(), NOW)).toEqual({ kind: 'ok', userId: USER_ID, state: 'running' })
    const starting = setup({ editor: { state: 'starting', startedAt: STARTED_AT } })
    expect(await starting.sessions.check(cookieFor(), NOW)).toEqual({ kind: 'ok', userId: USER_ID, state: 'starting' })
  })

  it('rejects missing, forged and expired cookies', async () => {
    const { sessions } = setup()
    expect(await sessions.check(undefined, NOW)).toEqual({ kind: 'invalid' })
    expect(await sessions.check('scantor.session_token=abc', NOW)).toEqual({ kind: 'invalid' })
    const forged = createKeyring('other').editorCookie(USER_ID, STARTED_AT.getTime(), NOW + 1000)
    expect(await sessions.check(`scantor_editor=${forged}`, NOW)).toEqual({ kind: 'invalid' })
    expect(await sessions.check(cookieFor(STARTED_AT, NOW), NOW)).toEqual({ kind: 'invalid' })
  })

  it('rejects deleted and banned users', async () => {
    expect(await setup({ user: null }).sessions.check(cookieFor(), NOW)).toEqual({ kind: 'invalid' })
    expect(await setup({ user: { ...activeUser, banned: true } }).sessions.check(cookieFor(), NOW)).toEqual({ kind: 'invalid' })
  })

  it('treats cookies of stopped or restarted editors as ended', async () => {
    expect(await setup({ editor: null }).sessions.check(cookieFor(), NOW)).toEqual({ kind: 'ended', userId: USER_ID })
    expect(await setup({ editor: { state: 'stopping', startedAt: STARTED_AT } }).sessions.check(cookieFor(), NOW)).toEqual({ kind: 'ended', userId: USER_ID })
    const restarted = setup({ editor: { state: 'running', startedAt: new Date(STARTED_AT.getTime() + 5) } })
    expect(await restarted.sessions.check(cookieFor(), NOW)).toEqual({ kind: 'ended', userId: USER_ID })
  })

  it('uses the first valid cookie when several are sent', async () => {
    const { sessions } = setup()
    expect(await sessions.check(`scantor_editor=junk; ${cookieFor()}`, NOW)).toMatchObject({ kind: 'ok' })
  })

  it('caches the editor state for at most 5 s and forgets it on invalidate', async () => {
    const { sessions, state } = setup({ stateTtlMs: 5_000 })
    await sessions.check(cookieFor(), NOW)
    await sessions.check(cookieFor(), NOW + 4_999)
    expect(state.loads).toBe(1)
    state.editor = { state: 'stopped', startedAt: STARTED_AT }
    expect(await sessions.check(cookieFor(), NOW + 5_000)).toMatchObject({ kind: 'ended' })
    expect(state.loads).toBe(2)
    state.editor = { state: 'running', startedAt: STARTED_AT }
    sessions.invalidate(USER_ID)
    expect(await sessions.check(cookieFor(), NOW + 5_001)).toMatchObject({ kind: 'ok' })
  })
})

describe('EditorSessions.redeem', () => {
  it('turns a code into a 12 h cookie bound to the current startedAt', async () => {
    const { sessions, codes } = setup()
    const { code } = codes.issue(USER_ID, 'echo', NOW)
    const redemption = await sessions.redeem(code, NOW)
    expect(redemption).toEqual({
      kind: 'ok',
      userId: USER_ID,
      cookieValue: sign(USER_ID, STARTED_AT.getTime(), NOW + 12 * 3_600_000),
      location: '/?folder=/home/coder/workspace/echo',
    })
    expect(await sessions.redeem(code, NOW)).toEqual({ kind: 'invalid' })
  })

  it('refuses expired codes, banned users and editors that are not live', async () => {
    const expired = setup()
    expect(await expired.sessions.redeem(expired.codes.issue(USER_ID, null, NOW).code, NOW + 60_000)).toEqual({ kind: 'invalid' })
    const banned = setup({ user: { ...activeUser, banned: true } })
    expect(await banned.sessions.redeem(banned.codes.issue(USER_ID, null, NOW).code, NOW)).toEqual({ kind: 'invalid' })
    const stopped = setup({ editor: { state: 'stopped', startedAt: STARTED_AT } })
    expect(await stopped.sessions.redeem(stopped.codes.issue(USER_ID, null, NOW).code, NOW)).toEqual({ kind: 'ended', userId: USER_ID })
  })

  it('builds the landing folder', () => {
    expect(editorLandingPath(null)).toBe('/?folder=/home/coder/workspace')
    expect(editorLandingPath('echo')).toBe('/?folder=/home/coder/workspace/echo')
  })
})
