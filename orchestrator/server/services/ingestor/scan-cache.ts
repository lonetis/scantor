import type { ChangeStream, ChangeStreamDocument, Collection, ResumeToken } from 'mongodb'
import type { ScanState, SchedulingState } from '#shared/utils/enums'
import type { ScanDoc } from '../../types/documents'
import type { Logger } from '../../utils/logger'

/*
 * The ingestor's scan-state cache (docs/queue.md §6.3): scanId → the few scan fields a flush needs.
 *
 *  - Fill: at the start of each flush, the missing scans of the batch are loaded with one `$in` query. Scans
 *    without a document are cached as unknown for 60 s.
 *  - Invalidation: a change stream on `scans` (insert, update, replace, delete) drops the entry of the changed scan.
 *    When the stream fails it is reopened with backoff and the whole cache is cleared; while it is down, entries
 *    older than 5 s are reloaded.
 *  - Fresh reads: `reload` ignores the cache (a message from a round above the cached one, §6.2 check 5).
 */

export interface CachedScan {
  id: string
  /** false when no scan document exists */
  exists: boolean
  state: ScanState | null
  round: number
  userId: string
  schedulingState: SchedulingState | null
  confirmed: number
  /** epoch ms of the last pause (user or breaker); a change means the scan left `running` meanwhile */
  pausedAt: number | null
  /** live hint counters as last read (docs/data-model.md §4.5.3) */
  stats: { succeeded: number; failed: number; lost: number; cancelled: number }
  fetchedAt: number
}

export const UNKNOWN_SCAN_TTL_MS = 60_000
export const STALE_WITHOUT_STREAM_MS = 5_000
const REOPEN_MIN_MS = 1_000
const REOPEN_MAX_MS = 30_000

type ScanProjection = Pick<ScanDoc, '_id' | 'state' | 'round' | 'userId'> & {
  pausedAt?: Date | null
  scheduling?: Partial<Pick<ScanDoc['scheduling'], 'state' | 'confirmed'>>
  stats?: Partial<ScanDoc['stats']>
}

const PROJECTION = {
  state: 1,
  round: 1,
  userId: 1,
  pausedAt: 1,
  'scheduling.state': 1,
  'scheduling.confirmed': 1,
  'stats.succeeded': 1,
  'stats.failed': 1,
  'stats.lost': 1,
  'stats.cancelled': 1,
}

export interface ScanCacheOptions {
  now?: () => number
  /** open the change stream (default true; unit tests without a replica set pass false) */
  watch?: boolean
}

export class ScanStateCache {
  private readonly entries = new Map<string, CachedScan>()
  private readonly now: () => number
  private stream: ChangeStream<ScanDoc> | null = null
  private streaming = false
  private stopped = true
  private resumeToken: ResumeToken | undefined
  private reopenDelay = REOPEN_MIN_MS
  private reopenTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly scans: Collection<ScanDoc>,
    private readonly log: Logger,
    private readonly options: ScanCacheOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    if (this.options.watch !== false) this.openStream()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reopenTimer) clearTimeout(this.reopenTimer)
    this.reopenTimer = null
    const stream = this.stream
    this.stream = null
    this.streaming = false
    await stream?.close().catch((error: unknown) => this.log.debug('closing the scans change stream failed', { err: error }))
  }

  private openStream(): void {
    if (this.stopped) return
    let stream: ChangeStream<ScanDoc>
    try {
      // Only the key of the changed scan is needed; the projection keeps `_id` (the resume token).
      stream = this.scans.watch<ScanDoc, ChangeStreamDocument<ScanDoc>>(
        [{ $project: { operationType: 1, documentKey: 1 } }],
        this.resumeToken ? { resumeAfter: this.resumeToken } : {},
      )
    } catch (error) {
      this.streamFailed(error)
      return
    }
    this.stream = stream
    this.streaming = true
    stream.on('change', (change: ChangeStreamDocument<ScanDoc>) => {
      this.resumeToken = change._id
      this.reopenDelay = REOPEN_MIN_MS
      if ('documentKey' in change && change.documentKey) this.entries.delete(String(change.documentKey._id))
    })
    stream.on('error', (error: unknown) => this.streamFailed(error))
    // An invalidate event (collection dropped or renamed) ends the stream without an error.
    stream.on('close', () => {
      if (this.stream === stream) this.streamFailed(new Error('the scans change stream closed'))
    })
  }

  private streamFailed(error: unknown): void {
    if (this.stopped) return
    this.log.warn('scans change stream failed; reopening, the scan cache is cleared meanwhile', { err: error })
    const stream = this.stream
    this.stream = null
    this.streaming = false
    this.entries.clear()
    // A resume token that the oplog no longer holds would fail forever: start fresh after an error.
    this.resumeToken = undefined
    void stream?.close().catch(() => undefined)
    if (this.reopenTimer) return
    const delay = this.reopenDelay
    this.reopenDelay = Math.min(REOPEN_MAX_MS, this.reopenDelay * 2)
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null
      this.openStream()
    }, delay)
  }

  private fresh(entry: CachedScan, now: number): boolean {
    if (!entry.exists && now - entry.fetchedAt > UNKNOWN_SCAN_TTL_MS) return false
    if (!this.streaming && now - entry.fetchedAt > STALE_WITHOUT_STREAM_MS) return false
    return true
  }

  private toEntry(doc: ScanProjection, now: number): CachedScan {
    return {
      id: doc._id,
      exists: true,
      state: doc.state,
      round: doc.round,
      userId: doc.userId,
      schedulingState: doc.scheduling?.state ?? null,
      confirmed: doc.scheduling?.confirmed ?? 0,
      pausedAt: doc.pausedAt instanceof Date ? doc.pausedAt.getTime() : null,
      stats: {
        succeeded: doc.stats?.succeeded ?? 0,
        failed: doc.stats?.failed ?? 0,
        lost: doc.stats?.lost ?? 0,
        cancelled: doc.stats?.cancelled ?? 0,
      },
      fetchedAt: now,
    }
  }

  private async fetch(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const now = this.now()
    const docs = (await this.scans.find({ _id: { $in: ids } }, { projection: PROJECTION }).toArray()) as ScanProjection[]
    const found = new Set<string>()
    for (const doc of docs) {
      found.add(doc._id)
      this.entries.set(doc._id, this.toEntry(doc, now))
    }
    for (const id of ids) {
      if (found.has(id)) continue
      this.entries.set(id, {
        id,
        exists: false,
        state: null,
        round: 0,
        userId: '',
        schedulingState: null,
        confirmed: 0,
        pausedAt: null,
        stats: { succeeded: 0, failed: 0, lost: 0, cancelled: 0 },
        fetchedAt: now,
      })
    }
  }

  /** Ensures entries for `ids` (one query for the missing or expired ones) and returns them. */
  async load(ids: Iterable<string>): Promise<Map<string, CachedScan>> {
    const wanted = [...new Set(ids)]
    const now = this.now()
    await this.fetch(wanted.filter((id) => {
      const entry = this.entries.get(id)
      return !entry || !this.fresh(entry, now)
    }))
    return new Map(wanted.flatMap((id) => {
      const entry = this.entries.get(id)
      return entry ? [[id, entry] as const] : []
    }))
  }

  /** Re-reads `ids` from MongoDB, ignoring the cache. */
  async reload(ids: Iterable<string>): Promise<Map<string, CachedScan>> {
    const wanted = [...new Set(ids)]
    await this.fetch(wanted)
    return new Map(wanted.flatMap((id) => {
      const entry = this.entries.get(id)
      return entry ? [[id, entry] as const] : []
    }))
  }

  get(id: string): CachedScan | undefined {
    return this.entries.get(id)
  }

  invalidate(id: string): void {
    this.entries.delete(id)
  }
}
