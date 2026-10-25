import type { H3Event } from 'h3'
import type { TestRunStreamEvents } from '#shared/types/test-runs'
import type { TestRunDoc } from '../../types/documents'
import { shutdownSignal } from '../../utils/boot'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { reserveWait } from '../../utils/wait'
import { isTestRunLive, recentTestRunLogs, subscribeTestRun, type TestRunEvent } from './live'
import { isTestRunSettled, toApiTestRun, toApiTestRunAnalysis } from './mappers'

// streamTestRun (docs/api.md §4.11, docs/ui.md §5.8): a `text/event-stream` with the events `state`, `log`,
// `analysis`, `error` and `end`. A subscriber first gets the current state, the stored analyses and errors and the
// recent log lines; then the live events of the job when this process runs it. A run executed elsewhere (or not yet
// claimed) is followed by polling MongoDB every 2 s, so `state`, `analysis` and `end` always arrive. The stream
// ends after `end`, when the client disconnects or when the orchestrator begins to stop (the client falls back to
// polling). An open stream holds one of the caller's SCANTOR_MAX_CONCURRENT_WAITS slots (429 before the stream
// starts). Only `log` events are unbounded, so while the client reads too slowly (the response buffer is full) they
// are dropped and counted, and one marker line reports the count once the buffer drained; every other event is
// bounded by the run (its limit, at most 200 errors) and always sent. A client that stops reading altogether loses
// the stream once MAX_BUFFERED_BYTES are queued for it (it can poll getTestRun instead).

const POLL_MS = 2000
const HEARTBEAT_MS = 15_000
/** Output queued for one client beyond which the stream is dropped. */
export const MAX_BUFFERED_BYTES = 8 * 1024 ** 2

type StreamEventName = keyof TestRunStreamEvents

export function formatSseEvent(name: StreamEventName, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/** The `log` event that reports how many log lines a slow client missed. */
export function droppedLogsLine(count: number, at = new Date()): TestRunStreamEvents['log'] {
  return { seq: null, stream: 'stderr', text: `[${count} log line${count === 1 ? '' : 's'} dropped: the stream was read too slowly]`, at: at.toISOString() }
}

export interface StreamTestRunOptions {
  /** the caller, whose wait budget (SCANTOR_MAX_CONCURRENT_WAITS) the open stream uses */
  userId: string
}

/** Writes the stream of one test run to the response; resolves when the stream ends. */
export async function streamTestRun(event: H3Event, initial: TestRunDoc, options: StreamTestRunOptions): Promise<void> {
  // Before the headers, so a refusal is an ordinary 429.
  const release = reserveWait(options.userId)
  try {
    await runStream(event, initial)
  } finally {
    release()
  }
}

async function runStream(event: H3Event, initial: TestRunDoc): Promise<void> {
  const res = event.node.res
  const log = useLogger('test-runs')
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()

  // Analyses are final when written (one document per seq), so each is sent once.
  const sentAnalyses = new Set<number>()
  const sentErrors = new Set<string>()
  let lastState = initial.state
  let ended = false
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })

  /** true while the response buffer is full; log events are dropped (and counted) until it drains */
  let congested = false
  let droppedLogs = 0
  const write = (name: StreamEventName, data: unknown) => {
    if (ended || res.writableEnded) return
    if (res.write(formatSseEvent(name, data))) return
    congested = true
    if (res.writableLength > MAX_BUFFERED_BYTES) abandon()
  }
  const writeLog = (data: TestRunStreamEvents['log']) => {
    if (ended || res.writableEnded) return
    if (congested) {
      droppedLogs++
      return
    }
    write('log', data)
  }
  const onDrain = () => {
    congested = false
    if (droppedLogs === 0) return
    const count = droppedLogs
    droppedLogs = 0
    write('log', droppedLogsLine(count))
  }
  const close = () => {
    if (ended) return
    ended = true
    if (!res.writableEnded) res.end()
    finish()
  }
  /** Drops the connection of a client that does not read: ending it would keep the queued output until it reads. */
  const abandon = () => {
    if (ended) return
    log.debug('dropping a test-run stream whose client does not read', { testRunId: initial._id, bufferedBytes: res.writableLength })
    ended = true
    res.destroy()
    finish()
  }

  /** Sends what MongoDB knows that the client has not seen yet; ends the stream once the run settled. */
  const catchUp = async (): Promise<void> => {
    const { testRuns, testRunAnalyses } = useCollections()
    const doc = await testRuns.findOne({ _id: initial._id })
    if (!doc) {
      close()
      return
    }
    if (doc.state !== lastState) {
      lastState = doc.state
      write('state', { state: doc.state })
    }
    const analyses = await testRunAnalyses.find({ testRunId: doc._id, seq: { $nin: [...sentAnalyses] } }).sort({ seq: 1 }).toArray()
    for (const analysis of analyses) {
      if (sentAnalyses.has(analysis.seq)) continue
      sentAnalyses.add(analysis.seq)
      write('analysis', toApiTestRunAnalysis(analysis))
    }
    for (const error of doc.errors) {
      const key = JSON.stringify(error)
      if (sentErrors.has(key)) continue
      sentErrors.add(key)
      write('error', error)
    }
    if (isTestRunSettled(doc)) {
      write('end', toApiTestRun(doc))
      close()
    }
  }

  const onLive = (live: TestRunEvent) => {
    switch (live.event) {
      case 'state':
        lastState = live.data.state
        write('state', live.data)
        return
      case 'analysis':
        if (sentAnalyses.has(live.data.seq)) return
        sentAnalyses.add(live.data.seq)
        write('analysis', live.data)
        return
      case 'error': {
        const key = JSON.stringify(live.data)
        if (sentErrors.has(key)) return
        sentErrors.add(key)
        write('error', live.data)
        return
      }
      case 'log':
        writeLog(live.data)
        return
      case 'end':
        // The final document is the authoritative `end`; catching up also sends anything missed meanwhile.
        void catchUp().catch((error: unknown) => log.warn('catching up a test-run stream failed', { err: error }))
        return
    }
  }

  const unsubscribe = subscribeTestRun(initial._id, onLive)
  const heartbeat = setInterval(() => {
    if (!ended && !res.writableEnded && !congested) res.write(': keepalive\n\n')
  }, HEARTBEAT_MS)
  let polling = false
  const poll = setInterval(() => {
    if (polling || ended) return
    polling = true
    catchUp()
      .catch((error: unknown) => log.warn('polling a test run failed', { err: error }))
      .finally(() => {
        polling = false
      })
  }, POLL_MS)
  res.once('close', close)
  res.on('drain', onDrain)
  // Like long-polls (docs/api.md §1.9), open streams end at once when the shutdown begins.
  const stopping = shutdownSignal()
  stopping.addEventListener('abort', close, { once: true })

  try {
    if (stopping.aborted) close()
    write('state', { state: initial.state })
    if (isTestRunLive(initial._id)) for (const line of recentTestRunLogs(initial._id)) writeLog(line)
    await catchUp()
    await done
  } finally {
    clearInterval(heartbeat)
    clearInterval(poll)
    stopping.removeEventListener('abort', close)
    res.off('drain', onDrain)
    unsubscribe()
  }
}
