import { apiError } from '../../utils/errors'
import { MAX_READS_PER_RUN } from './limits'

// Concurrent reads of one script run in this orchestrator process (docs/scripts.md): analysis streams and
// aggregations together, at most MAX_READS_PER_RUN, else 429 tooManyRequests. A script run has this budget of its own;
// it never takes the owner's interactive query slots (SCANTOR_USER_MAX_CONCURRENT_QUERIES).

const active = new Map<string, number>()

/** Takes a read slot of the run or throws 429; the returned function releases it (idempotent). */
export function acquireRunReadSlot(scriptRunId: string, limit = MAX_READS_PER_RUN): () => void {
  const current = active.get(scriptRunId) ?? 0
  if (current >= limit) throw apiError('tooManyRequests', `at most ${limit} concurrent analysis streams and aggregations per script run`, { limit })
  active.set(scriptRunId, current + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (active.get(scriptRunId) ?? 1) - 1
    if (remaining <= 0) active.delete(scriptRunId)
    else active.set(scriptRunId, remaining)
  }
}

/** Open reads of a run (tests). */
export function activeRunReads(scriptRunId: string): number {
  return active.get(scriptRunId) ?? 0
}
