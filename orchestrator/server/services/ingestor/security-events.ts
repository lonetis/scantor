import { randomUUID } from 'node:crypto'
import type { Collection } from 'mongodb'
import type { EventDoc } from '../../types/documents'
import { headBytes } from './build-document'

// `security.ingestRejected` events (docs/queue.md §7, docs/data-model.md §4.11, security.md ING-1): written by the
// dead-letter consumer for result messages the result consumer rejected, admin-only (`userId: null`), at most one
// per (routing key, reason) per minute. Values come from an untrusted publisher and are size-bounded.

export const REJECTION_EVENT_INTERVAL_MS = 60_000
const VALUE_MAX_BYTES = 256

export class RejectionEvents {
  private readonly lastWritten = new Map<string, number>()

  constructor(
    private readonly events: Collection<EventDoc>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Writes the event unless one for the same routing key and reason was written within the last minute. */
  async record(reason: string, routingKey: string, userIdProperty: string | null): Promise<boolean> {
    const now = this.now()
    for (const [key, at] of this.lastWritten) if (now - at >= REJECTION_EVENT_INTERVAL_MS) this.lastWritten.delete(key)
    const key = JSON.stringify([routingKey, reason])
    if (this.lastWritten.has(key)) return false
    this.lastWritten.set(key, now)
    const safeRoutingKey = headBytes(routingKey, VALUE_MAX_BYTES)
    await this.events.insertOne({
      _id: randomUUID(),
      at: new Date(now),
      type: 'security.ingestRejected',
      level: 'warning',
      userId: null,
      message: headBytes(`a result message was rejected (${reason}); routing key "${safeRoutingKey}"`, 1024),
      data: {
        reason,
        routingKey: safeRoutingKey,
        userIdProperty: userIdProperty === null ? null : headBytes(userIdProperty, VALUE_MAX_BYTES),
      },
    })
    return true
  }
}
