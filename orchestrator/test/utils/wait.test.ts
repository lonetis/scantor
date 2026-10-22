import { EventEmitter } from 'node:events'
import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Config, parseConfig, setConfigForTesting } from '../../server/utils/config'
import { loadWithWait } from '../../server/utils/wait'

// Long-polling with `wait` (docs/api.md §1.9), using the 1 s polling fallback (no change stream).

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

function fakeEvent(): { event: H3Event; res: FakeResponse } {
  const res = new FakeResponse()
  return { event: { node: { res, req: {} } } as unknown as H3Event, res }
}

let config: Config

beforeEach(() => {
  config = parseConfig({ SCANTOR_MAX_CONCURRENT_WAITS: '1' }).config
  setConfigForTesting(config)
})

afterEach(() => {
  setConfigForTesting(null)
})

describe('loadWithWait', () => {
  it('returns at once without wait and sets no header', async () => {
    const { event, res } = fakeEvent()
    expect(await loadWithWait(event, { waitSeconds: 0, userId: 'u', load: async () => 'running', settled: (v) => v === 'done' })).toBe('running')
    expect(res.headers['scantor-wait']).toBeUndefined()
  })

  it('reports settled at once when the resource is already settled', async () => {
    const { event, res } = fakeEvent()
    expect(await loadWithWait(event, { waitSeconds: 5, userId: 'u', load: async () => 'done', settled: (v) => v === 'done' })).toBe('done')
    expect(res.headers['scantor-wait']).toBe('settled')
  })

  it('holds the request until the resource settles', async () => {
    const { event, res } = fakeEvent()
    let loads = 0
    const result = await loadWithWait(event, { waitSeconds: 5, userId: 'u', load: async () => (++loads >= 2 ? 'done' : 'running'), settled: (v) => v === 'done' })
    expect(result).toBe('done')
    expect(res.headers['scantor-wait']).toBe('settled')
  })

  it('returns the current state with timeout when the wait elapses', async () => {
    const { event, res } = fakeEvent()
    expect(await loadWithWait(event, { waitSeconds: 1, userId: 'u', load: async () => 'running', settled: () => false })).toBe('running')
    expect(res.headers['scantor-wait']).toBe('timeout')
  })

  it('limits concurrent waits per user and frees the slot afterwards', async () => {
    const first = fakeEvent()
    const pending = loadWithWait(first.event, { waitSeconds: 1, userId: 'u', load: async () => 'running', settled: () => false })
    const second = fakeEvent()
    await expect(loadWithWait(second.event, { waitSeconds: 1, userId: 'u', load: async () => 'running', settled: () => false })).rejects.toMatchObject({
      code: 'tooManyRequests',
      details: { limit: 1 },
    })
    expect(await loadWithWait(fakeEvent().event, { waitSeconds: 0, userId: 'u', load: async () => 'x', settled: () => false })).toBe('x')
    await pending
    const third = fakeEvent()
    expect(await loadWithWait(third.event, { waitSeconds: 5, userId: 'u', load: async () => 'done', settled: (v) => v === 'done' })).toBe('done')
  })

  it('stops waiting when the client disconnects', async () => {
    const { event, res } = fakeEvent()
    const started = Date.now()
    const pending = loadWithWait(event, { waitSeconds: 30, userId: 'u', load: async () => 'running', settled: () => false })
    setTimeout(() => res.emit('close'), 50)
    expect(await pending).toBe('running')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
