import type { EventDoc } from '../types/documents'
import { useLogger } from './logger'

/*
 * Event sinks: consumers of the timeline events (docs/data-model.md §4.11) right after they were written, for example
 * the push notifications (server/services/notifications). The event writers (services/scans/events.ts,
 * services/nodes/events.ts) call publishEvents after a successful insert; domain plugins register sinks
 * synchronously at load:
 *
 *   registerEventSink({ name: 'notifications', accept: (event) => …, async consume(events) { … } })
 *
 * Events are informational, so a sink never slows down or fails the operation that wrote them: publishEvents
 * returns at once, sinks run detached, and their failures are logged. `accept` is a cheap synchronous filter that
 * runs inline, so the events no sink wants cost nothing beyond it. A sink that must not lose work persists it
 * (for example as a job) inside `consume`.
 */

export interface EventSink {
  name: string
  /** cheap synchronous filter; consume receives only the accepted events */
  accept(event: EventDoc): boolean
  consume(events: EventDoc[]): Promise<void>
}

const globalKey = '__scantorEventSinks'
type GlobalWithSinks = typeof globalThis & { [globalKey]?: EventSink[] }

function sinks(): EventSink[] {
  const global = globalThis as GlobalWithSinks
  global[globalKey] ??= []
  return global[globalKey]
}

export function registerEventSink(sink: EventSink): void {
  if (sinks().some((existing) => existing.name === sink.name)) throw new Error(`event sink ${sink.name} is registered twice`)
  sinks().push(sink)
}

/** Clears registered sinks (server/plugins/00.boot.ts and tests). */
export function resetEventSinks(): void {
  sinks().length = 0
}

/** Hands written events to every sink that accepts some of them; never throws and never waits for the sinks. */
export function publishEvents(events: readonly EventDoc[]): void {
  for (const sink of sinks()) {
    let accepted: EventDoc[]
    try {
      accepted = events.filter((event) => sink.accept(event))
    } catch (error) {
      useLogger('events').warn('an event sink rejected events', { sink: sink.name, err: error })
      continue
    }
    if (accepted.length === 0) continue
    void Promise.resolve()
      .then(() => sink.consume(accepted))
      .catch((error: unknown) => {
        useLogger('events').warn('an event sink failed', { sink: sink.name, count: accepted.length, err: error })
      })
  }
}
