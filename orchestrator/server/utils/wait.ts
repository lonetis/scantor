import { type H3Event, setResponseHeader } from 'h3'
import { shutdownSignal } from './boot'
import { useConfig } from './config'
import { apiError } from './errors'
import { useWaitWatchers, type WaitWatch, type WatchedCollection } from './wait-watchers'

// Long-polling with `wait` (docs/api.md §1.9): return at once when the resource is settled, otherwise hold the
// request until it settles or `wait` seconds elapse, then return the current representation. `Scantor-Wait:
// settled|timeout` tells which. A client disconnect aborts the wait; each user holds at most
// SCANTOR_MAX_CONCURRENT_WAITS waits (429). Changes of the document wake the wait through the process's shared change
// stream of its collection (utils/wait-watchers.ts), polling every second while that stream is unavailable. When the
// orchestrator begins to stop, waits answer at once with the current state (`timeout`), so the shutdown does not wait
// for them. A route that creates the resource it then waits for reserves the wait first (reserveWait), so its 429
// always means nothing was created; the test-run stream holds a reservation for as long as it is open.

const POLL_MS = 1000
const activeWaits = new Map<string, number>()

export interface WaitOptions<T> {
  /** seconds to wait (0 = no wait) */
  waitSeconds: number | undefined
  /** owner of the wait budget (the caller's user id) */
  userId: string
  /** loads the current state */
  load: () => Promise<T>
  /** true when the state is final for this wait */
  settled: (value: T) => boolean
  /** the document whose changes wake the wait (utils/wait-watchers.ts) */
  watch?: { collection: WatchedCollection; id: string }
  /** the caller holds a reservation of reserveWait for this wait (and releases it) */
  reserved?: boolean
}

/**
 * Takes one of the user's SCANTOR_MAX_CONCURRENT_WAITS slots, or throws 429 tooManyRequests. The returned release is
 * idempotent.
 */
export function reserveWait(userId: string): () => void {
  const limit = useConfig().maxConcurrentWaits
  const current = activeWaits.get(userId) ?? 0
  if (current >= limit) throw apiError('tooManyRequests', `at most ${limit} concurrent waits per user`, { limit })
  activeWaits.set(userId, current + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (activeWaits.get(userId) ?? 1) - 1
    if (count <= 0) activeWaits.delete(userId)
    else activeWaits.set(userId, count)
  }
}

/** For a create route with `wait`: the reservation to hold across the side effect and the wait, or null without one. */
export function reserveWaitFor(userId: string, waitSeconds: number | undefined): (() => void) | null {
  return (waitSeconds ?? 0) > 0 ? reserveWait(userId) : null
}

/** Resolves when the client disconnects before the response is sent. */
function clientGone(event: H3Event): Promise<void> {
  return new Promise((resolve) => {
    event.node.res.once('close', () => {
      if (!event.node.res.writableEnded) resolve()
    })
  })
}

/** Loads a resource, waiting up to `waitSeconds` for it to settle. */
export async function loadWithWait<T>(event: H3Event, options: WaitOptions<T>): Promise<T> {
  let value = await options.load()
  const waitSeconds = options.waitSeconds ?? 0
  if (waitSeconds <= 0) return value
  if (options.settled(value)) {
    setResponseHeader(event, 'Scantor-Wait', 'settled')
    return value
  }

  const release = options.reserved ? null : reserveWait(options.userId)

  const deadline = Date.now() + waitSeconds * 1000
  let wake: (() => void) | null = null
  /** set by a change notification, so a change that arrives while the state loads is not slept through */
  let changed = false
  let disconnected = false
  void clientGone(event).then(() => {
    disconnected = true
    wake?.()
  })
  const stopping = shutdownSignal()
  const onStopping = () => wake?.()
  stopping.addEventListener('abort', onStopping, { once: true })
  let watch: WaitWatch | null = null
  try {
    if (options.watch) {
      watch = useWaitWatchers().watch(options.watch.collection, options.watch.id, () => {
        changed = true
        wake?.()
      })
    }
    while (!disconnected && !stopping.aborted) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      if (!changed) {
        await new Promise<void>((resolve) => {
          // While changes arrive the timer is only a safety net; they wake the wait at once.
          const timer = setTimeout(resolve, Math.min(remaining, watch?.isStreaming() ? 5 * POLL_MS : POLL_MS))
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        wake = null
      }
      changed = false
      if (disconnected) break
      value = await options.load()
      if (options.settled(value)) {
        setResponseHeader(event, 'Scantor-Wait', 'settled')
        return value
      }
    }
    setResponseHeader(event, 'Scantor-Wait', 'timeout')
    return value
  } finally {
    stopping.removeEventListener('abort', onStopping)
    watch?.close()
    release?.()
  }
}
