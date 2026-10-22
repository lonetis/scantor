import type { Logger } from '../../utils/logger'

/*
 * Editor activity for the idle reaper (docs/editor.md §6.4): `editors.lastActivityAt = now` on proxied HTTP requests
 * (written at most once per minute per user) and every minute while the user has an open proxied WebSocket (an open
 * browser tab keeps its WebSocket, so it keeps the editor alive).
 */

export const ACTIVITY_WRITE_INTERVAL_MS = 60_000

export type ActivityWriter = (userId: string, at: Date) => Promise<void>

export class EditorActivity {
  private readonly lastWrite = new Map<string, number>()

  constructor(
    private readonly write: ActivityWriter,
    private readonly log: Logger,
    private readonly intervalMs = ACTIVITY_WRITE_INTERVAL_MS,
  ) {}

  private persist(userId: string, now: number): void {
    this.lastWrite.set(userId, now)
    this.write(userId, new Date(now)).catch((error: unknown) => {
      // Allow the next request to retry the write instead of waiting a full interval.
      this.lastWrite.delete(userId)
      this.log.warn('recording editor activity failed', { userId, err: error })
    })
  }

  /** A proxied HTTP request: persisted unless the last write of this user is younger than the interval. */
  touch(userId: string, now = Date.now()): void {
    const last = this.lastWrite.get(userId)
    if (last !== undefined && now - last < this.intervalMs) return
    this.persist(userId, now)
  }

  /** The once-a-minute heartbeat of users with open WebSockets: always persisted. */
  heartbeat(userIds: Iterable<string>, now = Date.now()): void {
    for (const userId of userIds) this.persist(userId, now)
  }

  forget(userId: string): void {
    this.lastWrite.delete(userId)
  }
}
