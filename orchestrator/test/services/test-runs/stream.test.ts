import { EventEmitter } from 'node:events'
import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestRunAnalysisDoc, TestRunDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// streamTestRun (docs/api.md §4.11): an open stream holds one of the caller's SCANTOR_MAX_CONCURRENT_WAITS slots,
// drops log lines (and counts them in one marker line) while the client reads too slowly, drops a client that stops
// reading, and ends at once when the orchestrator begins to stop.

const store = {
  testRuns: new FakeCollection<TestRunDoc>('testRuns'),
  testRunAnalyses: new FakeCollection<TestRunAnalysisDoc>('testRunAnalyses'),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({ testRuns: store.testRuns.asCollection(), testRunAnalyses: store.testRunAnalyses.asCollection() }),
}))

const { droppedLogsLine, MAX_BUFFERED_BYTES, streamTestRun } = await import('../../../server/services/test-runs/stream')
const { openTestRunChannel, publishTestRunEvent } = await import('../../../server/services/test-runs/live')
const { resetBootRegistry, stopComponents } = await import('../../../server/utils/boot')
const { parseConfig, setConfigForTesting } = await import('../../../server/utils/config')
const { useLogger } = await import('../../../server/utils/logger')
const { reserveWait } = await import('../../../server/utils/wait')

/** A ServerResponse whose write reports a full buffer while `reading` is false. */
class FakeResponse extends EventEmitter {
  readonly chunks: string[] = []
  status: number | null = null
  reading = true
  writableLength = 0
  writableEnded = false
  destroyed = false
  writeHead(status: number) {
    this.status = status
  }
  flushHeaders() {}
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return this.reading
  }
  end() {
    this.writableEnded = true
  }
  destroy() {
    this.destroyed = true
    this.emit('close')
  }
  events(name: string): unknown[] {
    return this.chunks.filter((chunk) => chunk.startsWith(`event: ${name}\n`)).map((chunk) => JSON.parse(chunk.split('\ndata: ')[1]!))
  }
}

function fakeEvent(): { event: H3Event; res: FakeResponse } {
  const res = new FakeResponse()
  return { event: { node: { res, req: {} } } as unknown as H3Event, res }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const USER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
let run: TestRunDoc
let counter = 0

beforeEach(async () => {
  setConfigForTesting(parseConfig({ SCANTOR_MAX_CONCURRENT_WAITS: '1' }).config)
  for (const collection of Object.values(store)) collection.docs.length = 0
  run = { _id: `run-${++counter}`, userId: USER, state: 'running', errors: [] } as unknown as TestRunDoc
  await store.testRuns.insertOne(run)
})

afterEach(() => {
  setConfigForTesting(null)
  resetBootRegistry()
})

const log = (text: string) => ({ event: 'log' as const, data: { seq: 0, stream: 'stdout' as const, text, at: '2026-10-21T09:00:00.000Z' } })

describe('streamTestRun', () => {
  it('holds one wait slot while open and answers 429 before any header beyond the budget', async () => {
    const first = fakeEvent()
    const open = streamTestRun(first.event, run, { userId: USER })
    await tick()
    expect(first.res.status).toBe(200)

    const second = fakeEvent()
    await expect(streamTestRun(second.event, run, { userId: USER })).rejects.toMatchObject({ code: 'tooManyRequests', details: { limit: 1 } })
    expect(second.res.status).toBeNull()

    first.res.emit('close')
    await open
    reserveWait(USER)()
  })

  it('drops log lines while the client reads too slowly and reports their count once the buffer drained', async () => {
    openTestRunChannel(run._id)
    const { event, res } = fakeEvent()
    const open = streamTestRun(event, run, { userId: USER })
    await tick()
    res.reading = false
    publishTestRunEvent(run._id, log('one'))
    publishTestRunEvent(run._id, log('two'))
    publishTestRunEvent(run._id, log('three'))
    // Bounded events are always sent.
    publishTestRunEvent(run._id, { event: 'state', data: { state: 'running' } })
    res.reading = true
    res.emit('drain')
    publishTestRunEvent(run._id, log('four'))
    expect(res.events('log').map((line) => (line as { text: string }).text)).toEqual(['one', droppedLogsLine(2).text, 'four'])
    expect(res.events('state')).toHaveLength(2)
    res.emit('close')
    await open
  })

  it('drops the connection of a client that stops reading', async () => {
    openTestRunChannel(run._id)
    const { event, res } = fakeEvent()
    const open = streamTestRun(event, run, { userId: USER })
    await tick()
    res.reading = false
    res.writableLength = MAX_BUFFERED_BYTES + 1
    publishTestRunEvent(run._id, { event: 'state', data: { state: 'running' } })
    await open
    expect(res.destroyed).toBe(true)
    expect(res.writableEnded).toBe(false)
    reserveWait(USER)()
  })

  it('ends at once when the shutdown begins', async () => {
    const { event, res } = fakeEvent()
    const open = streamTestRun(event, run, { userId: USER })
    await tick()
    await stopComponents(useLogger('test'))
    await open
    expect(res.writableEnded).toBe(true)

    const late = fakeEvent()
    await streamTestRun(late.event, run, { userId: USER })
    expect(late.res.writableEnded).toBe(true)
  })
})
