import { apiError } from '../../utils/errors'

// Per-user concurrency of queries, aggregations and inline exports (docs/api.md §5.2): at most
// SCANTOR_USER_MAX_CONCURRENT_QUERIES at once per user in this process, else 429 tooManyRequests. Background
// export jobs are bounded by the export job kind's per-user concurrency instead.

const active = new Map<string, number>()

/** Takes a slot for `userId` or throws 429; the returned function releases it (idempotent). */
export function acquireQuerySlot(userId: string, limit: number): () => void {
  const current = active.get(userId) ?? 0
  if (current >= limit) {
    throw apiError('tooManyRequests', `at most ${limit} concurrent queries and exports per user`, { limit })
  }
  active.set(userId, current + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (active.get(userId) ?? 1) - 1
    if (remaining <= 0) active.delete(userId)
    else active.set(userId, remaining)
  }
}

/** Runs `fn` while holding a query slot of `userId`. */
export async function withQuerySlot<T>(userId: string, limit: number, fn: () => Promise<T>): Promise<T> {
  const release = acquireQuerySlot(userId, limit)
  try {
    return await fn()
  } finally {
    release()
  }
}
