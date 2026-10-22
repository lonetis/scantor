import type { H3Event } from 'h3'
import type { TestRunStreamEvents } from '#shared/types/test-runs'
import type { TestRunDoc } from '../../types/documents'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { isTestRunLive, recentTestRunLogs, subscribeTestRun, type TestRunEvent } from './live'
import { isTestRunSettled, toApiTestRun, toApiTestRunAnalysis } from './mappers'

// streamTestRun (docs/api.md §4.11, docs/ui.md §5.8): a `text/event-stream` with the events `state`, `log`,
// `analysis`, `error` and `end`. A subscriber first gets the current state, the stored analyses and errors and the
// recent log lines; then the live events of the job when this process runs it. A run executed elsewhere (or not yet
// claimed) is followed by polling MongoDB every 2 s, so `state`, `analysis` and `end` always arrive. The stream
// ends after `end` or when the client disconnects.

const POLL_MS = 2000
const HEARTBEAT_MS = 15_000

type StreamEventName = keyof TestRunStreamEvents

export function formatSseEvent(name: StreamEventName, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

/** Writes the stream of one test run to the response; resolves when the stream ends. */
export async function streamTestRun(event: H3Event, initial: TestRunDoc): Promise<void> {
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

  const write = (name: StreamEventName, data: unknown) => {
    if (ended || res.writableEnded) return
    res.write(formatSseEvent(name, data))
  }
  const close = () => {
    if (ended) return
    ended = true
    if (!res.writableEnded) res.end()
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
    const analyses = await testRunAnalyses.find({ testRunId: doc._id }).sort({ seq: 1 }).toArray()
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
        write('log', live.data)
        return
      case 'end':
        // The final document is the authoritative `end`; catching up also sends anything missed meanwhile.
        void catchUp().catch((error: unknown) => log.warn('catching up a test-run stream failed', { err: error }))
        return
    }
  }

  const unsubscribe = subscribeTestRun(initial._id, onLive)
  const heartbeat = setInterval(() => {
    if (!ended && !res.writableEnded) res.write(': keepalive\n\n')
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

  try {
    write('state', { state: initial.state })
    if (isTestRunLive(initial._id)) for (const line of recentTestRunLogs(initial._id)) write('log', line)
    await catchUp()
    await done
  } finally {
    clearInterval(heartbeat)
    clearInterval(poll)
    unsubscribe()
  }
}
