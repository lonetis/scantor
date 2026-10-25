import { EventEmitter } from 'node:events'
import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetBootRegistry } from '../../server/utils/boot'
import { parseConfig, setConfigForTesting } from '../../server/utils/config'
import { useLogger } from '../../server/utils/logger'
import { loadWithWait } from '../../server/utils/wait'
import { closeWaitWatchers, useWaitWatchers, WaitWatchers, type WatchedCollection } from '../../server/utils/wait-watchers'

// Shared change streams of the `wait` long-polls (docs/api.md §1.9, security.md RES-9): one stream per collection and
// process, whatever the number of waits.

class FakeStream extends EventEmitter {
  closed = false
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }
}

class FakeCollection {
  readonly streams: FakeStream[] = []
  pipelines: unknown[] = []
  constructor(readonly collectionName: string) {}
  get namespace(): string {
    return `scantor.${this.collectionName}`
  }
  watch(pipeline: unknown): FakeStream {
    this.pipelines.push(pipeline)
    const stream = new FakeStream()
    this.streams.push(stream)
    return stream
  }
  /** the stream that is currently open */
  get open(): FakeStream[] {
    return this.streams.filter((stream) => !stream.closed)
  }
  change(id: string): void {
    for (const stream of this.open) stream.emit('change', { operationType: 'update', documentKey: { _id: id } })
  }
}

const asCollection = (fake: FakeCollection) => fake as unknown as WatchedCollection
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let watchers: WaitWatchers

beforeEach(() => {
  watchers = new WaitWatchers(useLogger('test'), { retryMs: 30, idleMs: 30 })
})

afterEach(async () => {
  await watchers.close()
})

describe('WaitWatchers', () => {
  it('opens one stream per collection, however many waits, and fans changes out by id', () => {
    const scans = new FakeCollection('scans')
    const jobs = new FakeCollection('jobs')
    const seen: string[] = []
    for (let i = 0; i < 50; i++) watchers.watch(asCollection(scans), `scan-${i % 5}`, () => seen.push(`scan-${i % 5}`))
    watchers.watch(asCollection(jobs), 'job-1', () => seen.push('job-1'))
    expect(scans.streams).toHaveLength(1)
    expect(jobs.streams).toHaveLength(1)
    expect(watchers.streamCount).toBe(2)

    scans.change('scan-3')
    expect(seen).toEqual(Array(10).fill('scan-3'))
    jobs.change('job-1')
    scans.change('scan-unwatched')
    expect(seen).toHaveLength(11)
    // Only the change types a wait needs, without the changed fields; the resume token `_id` stays.
    expect(scans.pipelines[0]).toEqual([
      { $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
      { $project: { operationType: 1, documentKey: 1 } },
    ])
  })

  it('closes a stream once its collection had no waits for the idle time, and keeps it for a quick re-poll', async () => {
    const scans = new FakeCollection('scans')
    const first = watchers.watch(asCollection(scans), 'a', () => undefined)
    first.close()
    first.close()
    // A re-poll within the idle time reuses the stream.
    const second = watchers.watch(asCollection(scans), 'a', () => undefined)
    await sleep(60)
    expect(scans.streams).toHaveLength(1)
    expect(scans.open).toHaveLength(1)
    second.close()
    await sleep(60)
    expect(scans.open).toHaveLength(0)
    expect(watchers.streamCount).toBe(0)
    // The next wait opens a new one.
    watchers.watch(asCollection(scans), 'a', () => undefined)
    expect(scans.open).toHaveLength(1)
  })

  it('wakes every wait of a failed stream, lets them poll and reopens the stream after the retry delay', async () => {
    const scans = new FakeCollection('scans')
    const woken: string[] = []
    const a = watchers.watch(asCollection(scans), 'a', () => woken.push('a'))
    const b = watchers.watch(asCollection(scans), 'b', () => woken.push('b'))
    expect(a.isStreaming()).toBe(true)
    scans.streams[0]!.emit('error', new Error('not primary'))
    expect(woken.sort()).toEqual(['a', 'b'])
    expect(scans.streams[0]!.closed).toBe(true)
    expect(a.isStreaming()).toBe(false)
    expect(scans.streams).toHaveLength(1)
    await sleep(50)
    expect(b.isStreaming()).toBe(true)
    expect(scans.streams).toHaveLength(2)
    scans.change('a')
    expect(woken.filter((id) => id === 'a')).toHaveLength(2)
  })

  it('treats a stream that closes by itself (invalidate) as failed', () => {
    const scans = new FakeCollection('scans')
    const woken: string[] = []
    const watch = watchers.watch(asCollection(scans), 'a', () => woken.push('a'))
    void scans.streams[0]!.close()
    expect(woken).toEqual(['a'])
    expect(watch.isStreaming()).toBe(false)
  })

  it('closes every stream on close and polls afterwards', async () => {
    const scans = new FakeCollection('scans')
    const watch = watchers.watch(asCollection(scans), 'a', () => undefined)
    await watchers.close()
    expect(scans.open).toHaveLength(0)
    expect(watch.isStreaming()).toBe(false)
    watchers.watch(asCollection(scans), 'b', () => undefined)
    expect(scans.streams).toHaveLength(1)
  })
})

describe('loadWithWait with a watched document', () => {
  class FakeResponse extends EventEmitter {
    readonly headers: Record<string, string> = {}
    writableEnded = false
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value
    }
    getHeader(name: string) {
      return this.headers[name.toLowerCase()]
    }
  }

  beforeEach(() => {
    setConfigForTesting(parseConfig({}).config)
  })

  afterEach(async () => {
    await closeWaitWatchers()
    setConfigForTesting(null)
    resetBootRegistry()
  })

  it('wakes on a change of its document at once and shares the stream with other waits', async () => {
    const scans = new FakeCollection('scans')
    const res = new FakeResponse()
    const event = { node: { res, req: {} } } as unknown as H3Event
    let state = 'running'
    const started = Date.now()
    const waits = [0, 1, 2].map((index) =>
      loadWithWait(index === 0 ? event : ({ node: { res: new FakeResponse(), req: {} } } as unknown as H3Event), {
        waitSeconds: 30,
        userId: `u${index}`,
        load: async () => state,
        settled: (value) => value === 'done',
        watch: { collection: asCollection(scans), id: 'scan-1' },
      }),
    )
    await sleep(50)
    expect(scans.streams).toHaveLength(1)
    expect(useWaitWatchers().streamCount).toBe(1)
    state = 'done'
    scans.change('scan-1')
    expect(await Promise.all(waits)).toEqual(['done', 'done', 'done'])
    expect(res.headers['scantor-wait']).toBe('settled')
    // Without the change the wait would have slept 5 s before its next read.
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
