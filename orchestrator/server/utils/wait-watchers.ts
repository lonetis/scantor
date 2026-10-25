import { EventEmitter } from 'node:events'
import type { ChangeStream, Collection, Document } from 'mongodb'
import { type Logger, useLogger } from './logger'

// Change notifications of the `wait` long-polls (docs/api.md §1.9, security.md RES-9). A listening change stream keeps
// one connection of the shared MongoDB pool busy with awaitData getMores, so a stream per waiting request let a few
// users with many waits occupy the whole pool. Instead each process opens at most one stream per waited-on collection
// (scans, revisions, testRuns, exports, jobs, workers), whatever the number of waits, and fans its events out by
// document id. A stream closes once its collection has had no waits for a short while. When a stream fails, every wait
// on its collection is woken and polls every second, and the stream is reopened after a delay.

export const STREAM_RETRY_MS = 5_000
export const STREAM_IDLE_MS = 10_000

export type WatchedCollection = Collection<Document & { _id: string }>

/** One wait's subscription to the changes of one document. */
export interface WaitWatch {
  /** Whether changes arrive (otherwise the wait polls); reopens a failed stream once its retry delay has passed. */
  isStreaming(): boolean
  close(): void
}

export interface WaitWatchersOptions {
  retryMs: number
  idleMs: number
}

interface CollectionWatch {
  collection: WatchedCollection
  emitter: EventEmitter
  stream: ChangeStream | null
  retryAt: number
  waits: number
  idleTimer: NodeJS.Timeout | null
}

/**
 * The events a wait cares about, without the changed fields: the `_id` resume token stays (an inclusion projection
 * keeps it), and the busy `scans` and `workers` collections send small events.
 */
const PIPELINE = [{ $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } }, { $project: { operationType: 1, documentKey: 1 } }]

export class WaitWatchers {
  private readonly watches = new Map<string, CollectionWatch>()
  private closed = false

  constructor(
    private readonly log: Logger,
    private readonly options: WaitWatchersOptions = { retryMs: STREAM_RETRY_MS, idleMs: STREAM_IDLE_MS },
  ) {}

  /** Calls `onChange` for every change of document `id` until the returned watch is closed. */
  watch(collection: WatchedCollection, id: string, onChange: () => void): WaitWatch {
    const entry = this.entryOf(collection)
    entry.emitter.on(id, onChange)
    entry.waits++
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    this.ensureStream(entry)
    let closed = false
    return {
      isStreaming: () => {
        this.ensureStream(entry)
        return entry.stream !== null
      },
      close: () => {
        if (closed) return
        closed = true
        entry.emitter.off(id, onChange)
        entry.waits--
        if (entry.waits === 0) this.closeWhenIdle(entry)
      },
    }
  }

  /** The number of open change streams (one per collection with waits). */
  get streamCount(): number {
    return [...this.watches.values()].filter((entry) => entry.stream !== null).length
  }

  /** Closes every stream (Nitro `close`); later waits poll. */
  async close(): Promise<void> {
    this.closed = true
    const streams: ChangeStream[] = []
    for (const entry of this.watches.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
      if (entry.stream) streams.push(entry.stream)
      entry.stream = null
      wakeAll(entry)
    }
    this.watches.clear()
    await Promise.all(streams.map((stream) => stream.close().catch((error: unknown) => this.log.debug('closing a wait change stream failed', { err: error }))))
  }

  private entryOf(collection: WatchedCollection): CollectionWatch {
    const key = collection.namespace
    let entry = this.watches.get(key)
    if (!entry) {
      const emitter = new EventEmitter()
      emitter.setMaxListeners(0)
      entry = { collection, emitter, stream: null, retryAt: 0, waits: 0, idleTimer: null }
      this.watches.set(key, entry)
    }
    return entry
  }

  private ensureStream(entry: CollectionWatch): void {
    if (this.closed || entry.stream || entry.waits === 0 || Date.now() < entry.retryAt) return
    let stream: ChangeStream
    try {
      stream = entry.collection.watch(PIPELINE)
    } catch (error) {
      this.failed(entry, null, error)
      return
    }
    entry.stream = stream
    stream.on('change', (change: { documentKey?: { _id?: unknown } }) => {
      const id = change.documentKey?._id
      if (id !== undefined && id !== null) entry.emitter.emit(String(id))
    })
    stream.on('error', (error: unknown) => this.failed(entry, stream, error))
    // An invalidated stream (the collection was dropped or renamed) closes without an error.
    stream.on('close', () => this.failed(entry, stream, new Error('the change stream closed')))
  }

  /** Marks the collection as polling until the retry delay passed and wakes its waits, which then poll. */
  private failed(entry: CollectionWatch, stream: ChangeStream | null, error: unknown): void {
    if (stream && entry.stream !== stream) return
    entry.stream = null
    entry.retryAt = Date.now() + this.options.retryMs
    if (!this.closed) {
      this.log.warn('wait change stream failed; its waits poll every second', { collection: entry.collection.collectionName, err: error })
    }
    void stream?.close().catch(() => undefined)
    wakeAll(entry)
  }

  private closeWhenIdle(entry: CollectionWatch): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null
      if (entry.waits > 0) return
      const stream = entry.stream
      entry.stream = null
      this.watches.delete(entry.collection.namespace)
      void stream?.close().catch((error: unknown) => this.log.debug('closing a wait change stream failed', { err: error }))
    }, this.options.idleMs)
    entry.idleTimer.unref()
  }
}

function wakeAll(entry: CollectionWatch): void {
  for (const name of entry.emitter.eventNames()) entry.emitter.emit(name)
}

let watchers: WaitWatchers | null = null

/** The process's watchers, created on first use. */
export function useWaitWatchers(): WaitWatchers {
  watchers ??= new WaitWatchers(useLogger('api'))
  return watchers
}

/** Closes the process's change streams (Nitro `close`, before the MongoDB client closes). */
export async function closeWaitWatchers(): Promise<void> {
  const current = watchers
  watchers = null
  await current?.close()
}
