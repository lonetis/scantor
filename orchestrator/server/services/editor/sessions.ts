import type { EditorState } from '#shared/utils/enums'
import type { CachedUser } from '../../utils/user-cache'
import { cookieValues, EDITOR_COOKIE_NAME, EDITOR_COOKIE_TTL_MS, type EditorCookieSigner, verifyEditorCookie } from './cookie'
import type { EditorCodeStore } from './codes'

/*
 * Who may use the editor origin (docs/editor.md §8.3–§8.4, docs/auth.md §12). The listener accepts exactly one
 * credential, the `scantor_editor` cookie, valid only when
 *   1. it parses and its MAC matches,
 *   2. it has not expired,
 *   3. the user exists and is not banned (the 30 s user cache of the auth middleware),
 *   4. the user's editor is starting or running with `startedAt == editorStartedAtMs` (cached ≤ 5 s), so stopping
 *      or restarting an editor invalidates all of its cookies.
 * A cookie that passes 1–3 but fails 4 belongs to an editor that has ended (410 page instead of 401).
 */

export const EDITOR_STATE_CACHE_TTL_MS = 5_000
export const WORKSPACE_ROOT = '/home/coder/workspace'

export interface EditorStateSnapshot {
  state: EditorState
  startedAt: Date | null
}

export type EditorAccess =
  | { kind: 'ok'; userId: string; state: 'starting' | 'running' }
  | { kind: 'ended'; userId: string }
  | { kind: 'invalid' }

export type CodeRedemption =
  | { kind: 'ok'; userId: string; cookieValue: string; location: string }
  | { kind: 'ended'; userId: string }
  | { kind: 'invalid' }

export interface EditorSessionDeps {
  sign: EditorCookieSigner
  /** the user cache (docs/auth.md §5.7) */
  getUser: (userId: string) => Promise<CachedUser | null>
  isBanned: (user: CachedUser) => boolean
  /** the user's `editors` document (state and startedAt only), or null */
  loadEditor: (userId: string) => Promise<EditorStateSnapshot | null>
  codes: EditorCodeStore
  stateTtlMs?: number
}

interface CachedState {
  snapshot: EditorStateSnapshot | null
  expiresAt: number
}

/** The folder code-server opens after the handoff: the task folder, or the workspace root. */
export function editorLandingPath(open: string | null): string {
  return `/?folder=${WORKSPACE_ROOT}${open ? `/${open}` : ''}`
}

export class EditorSessions {
  private readonly states = new Map<string, CachedState>()

  constructor(private readonly deps: EditorSessionDeps) {}

  /** Forgets the cached editor state of a user (start and stop do this, so cookies follow at once in-process). */
  invalidate(userId: string): void {
    this.states.delete(userId)
  }

  private async editorState(userId: string, now: number): Promise<EditorStateSnapshot | null> {
    const cached = this.states.get(userId)
    if (cached && cached.expiresAt > now) return cached.snapshot
    const snapshot = await this.deps.loadEditor(userId)
    this.states.set(userId, { snapshot, expiresAt: now + (this.deps.stateTtlMs ?? EDITOR_STATE_CACHE_TTL_MS) })
    if (this.states.size > 10_000) {
      for (const [id, entry] of this.states) if (entry.expiresAt <= now) this.states.delete(id)
    }
    return snapshot
  }

  private async userAllowed(userId: string): Promise<boolean> {
    const user = await this.deps.getUser(userId)
    return user !== null && !this.deps.isBanned(user)
  }

  /** Checks the `Cookie` header of an editor-origin request (rules 1–4 above). */
  async check(cookieHeader: string | string[] | undefined, now = Date.now()): Promise<EditorAccess> {
    let ended: EditorAccess | null = null
    for (const value of cookieValues(cookieHeader, EDITOR_COOKIE_NAME)) {
      const claims = verifyEditorCookie(value, this.deps.sign, now)
      if (!claims || !(await this.userAllowed(claims.userId))) continue
      const editor = await this.editorState(claims.userId, now)
      const live = editor && (editor.state === 'starting' || editor.state === 'running')
      if (live && editor.startedAt?.getTime() === claims.editorStartedAtMs) {
        return { kind: 'ok', userId: claims.userId, state: editor.state as 'starting' | 'running' }
      }
      ended ??= { kind: 'ended', userId: claims.userId }
    }
    return ended ?? { kind: 'invalid' }
  }

  /**
   * Redeems a one-time code (`GET /_auth?code=`): single use, unexpired, the user still allowed, and the editor
   * starting or running. The new cookie binds the editor's current `startedAt` and expires in 12 h.
   */
  async redeem(code: string, now = Date.now()): Promise<CodeRedemption> {
    const entry = this.deps.codes.consume(code, now)
    if (!entry || !(await this.userAllowed(entry.userId))) return { kind: 'invalid' }
    // Read fresh: the code was issued moments ago and may belong to an editor that just (re)started.
    this.invalidate(entry.userId)
    const editor = await this.editorState(entry.userId, now)
    if (!editor || (editor.state !== 'starting' && editor.state !== 'running') || !editor.startedAt) {
      return { kind: 'ended', userId: entry.userId }
    }
    const cookieValue = this.deps.sign(entry.userId, editor.startedAt.getTime(), now + EDITOR_COOKIE_TTL_MS)
    return { kind: 'ok', userId: entry.userId, cookieValue, location: editorLandingPath(entry.open) }
  }
}
