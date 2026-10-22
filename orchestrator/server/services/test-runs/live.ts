import { EventEmitter } from 'node:events'
import type { TestRunStreamEvents } from '#shared/types/test-runs'

// Live test-run events for `streamTestRun` (docs/api.md §4.11): the testRun job publishes `state`, `log`,
// `analysis`, `error` and `end` events in process; SSE subscribers receive them as they happen. A bounded ring of
// recent log lines lets a late subscriber catch up; analyses and errors are replayed from MongoDB by the route.
// (A multi-replica orchestrator would move this bus to MongoDB or RabbitMQ, docs/api.md §12.)

export type TestRunEventName = keyof TestRunStreamEvents
export type TestRunEvent = { [K in TestRunEventName]: { event: K; data: TestRunStreamEvents[K] } }[TestRunEventName]

export const LOG_RING_SIZE = 2000

interface Channel {
  emitter: EventEmitter
  logs: TestRunStreamEvents['log'][]
  /** true while this process executes the test run (between openTestRunChannel and its `end` event) */
  live: boolean
}

const channels = new Map<string, Channel>()

function channel(testRunId: string): Channel {
  let entry = channels.get(testRunId)
  if (!entry) {
    entry = { emitter: new EventEmitter(), logs: [], live: false }
    entry.emitter.setMaxListeners(100)
    channels.set(testRunId, entry)
  }
  return entry
}

/** Opens (or resets) the channel of a test run that this process is about to execute. */
export function openTestRunChannel(testRunId: string): void {
  const entry = channel(testRunId)
  entry.logs = []
  entry.live = true
}

export function publishTestRunEvent(testRunId: string, event: TestRunEvent): void {
  const entry = channel(testRunId)
  if (event.event === 'log') {
    entry.logs.push(event.data)
    if (entry.logs.length > LOG_RING_SIZE) entry.logs.splice(0, entry.logs.length - LOG_RING_SIZE)
  }
  if (event.event === 'end') entry.live = false
  entry.emitter.emit('event', event)
  if (event.event === 'end') {
    // Late subscribers read the final state from MongoDB; keep the channel briefly for in-flight connections.
    setTimeout(() => {
      if (channels.get(testRunId) === entry && entry.emitter.listenerCount('event') === 0) channels.delete(testRunId)
    }, 60_000).unref()
  }
}

/** True while this process executes the test run (its live events are available). */
export function isTestRunLive(testRunId: string): boolean {
  return channels.get(testRunId)?.live === true
}

/** Recent log lines of a live test run (for late subscribers). */
export function recentTestRunLogs(testRunId: string): TestRunStreamEvents['log'][] {
  return [...(channels.get(testRunId)?.logs ?? [])]
}

/**
 * Subscribes to the live events of a test run; returns the unsubscribe function. The channel of a run this process
 * does not execute (settled, not yet claimed, or run elsewhere) is dropped with its last subscriber.
 */
export function subscribeTestRun(testRunId: string, listener: (event: TestRunEvent) => void): () => void {
  const entry = channel(testRunId)
  entry.emitter.on('event', listener)
  return () => {
    entry.emitter.off('event', listener)
    if (!entry.live && entry.emitter.listenerCount('event') === 0 && channels.get(testRunId) === entry) channels.delete(testRunId)
  }
}

/** Number of open channels (for tests). */
export function testRunChannelCount(): number {
  return channels.size
}

// ── cancellation ────────────────────────────────────────────────────────────

const cancellations = new Map<string, AbortController>()

/** The abort controller the running job watches; cancelTestRun aborts it for an immediate stop. */
export function cancellationFor(testRunId: string): AbortController {
  const controller = new AbortController()
  cancellations.set(testRunId, controller)
  return controller
}

export function releaseCancellation(testRunId: string, controller: AbortController): void {
  if (cancellations.get(testRunId) === controller) cancellations.delete(testRunId)
}

/** Aborts the in-process execution of a test run, if this process runs it. */
export function requestCancellation(testRunId: string): boolean {
  const controller = cancellations.get(testRunId)
  if (!controller) return false
  controller.abort(new Error('test run cancelled'))
  return true
}
