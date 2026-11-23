import { EventEmitter } from 'node:events'
import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetBootRegistry, stopComponents } from '../../server/utils/boot'
import { type Config, parseConfig, setConfigForTesting } from '../../server/utils/config'
import { useLogger } from '../../server/utils/logger'
import { loadWithWait, reserveWait, reserveWaitFor } from '../../server/utils/wait'

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

function fakeEvent(requestOrigin?: 'public' | 'tunnel'): { event: H3Event; res: FakeResponse } {
  const res = new FakeResponse()
  // utils/tunnel.ts memoizes the classification of a request on its context
  return { event: { node: { res, req: {} }, context: requestOrigin ? { requestOrigin } : {} } as unknown as H3Event, res }
}

let config: Config

beforeEach(() => {
  config = parseConfig({ SCANTOR_MAX_CONCURRENT_WAITS: '1' }).config
  setConfigForTesting(config)
})

afterEach(() => {
  setConfigForTesting(null)
  resetBootRegistry()
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

  it('lets a create route reserve the wait before its side effect', async () => {
    const release = reserveWaitFor('u', 5)!
    // Another wait of the user is refused while the reservation is held, before anything would be created.
    expect(() => reserveWaitFor('u', 5)).toThrow(expect.objectContaining({ code: 'tooManyRequests' }))
    expect(reserveWaitFor('u', 0)).toBeNull()
    expect(await loadWithWait(fakeEvent().event, { waitSeconds: 1, userId: 'u', load: async () => 'running', settled: () => false, reserved: true })).toBe('running')
    release()
    release()
    const again = reserveWait('u')
    again()
  })

  it('stops waiting when the client disconnects', async () => {
    const { event, res } = fakeEvent()
    const started = Date.now()
    const pending = loadWithWait(event, { waitSeconds: 30, userId: 'u', load: async () => 'running', settled: () => false })
    setTimeout(() => res.emit('close'), 50)
    expect(await pending).toBe('running')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('answers at once with the current state when the orchestrator begins to stop', async () => {
    const { event, res } = fakeEvent()
    let loads = 0
    const started = Date.now()
    const pending = loadWithWait(event, { waitSeconds: 60, userId: 'u', load: async () => `running ${++loads}`, settled: () => false })
    setTimeout(() => void stopComponents(useLogger('test')), 50)
    // The state is read once more after the shutdown woke the wait.
    expect(await pending).toBe('running 2')
    expect(res.headers['scantor-wait']).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  describe('through the tunnel URL (Cloudflare answers 524 without a response within 125 s)', () => {
    beforeEach(() => {
      setConfigForTesting(parseConfig({ SCANTOR_MAX_CONCURRENT_WAITS: '1', SCANTOR_TUNNEL_URL: 'https://tunnel.example.org' }).config)
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** A wait for a resource that never settles, with whether it has answered yet. */
    function neverSettling(requestOrigin: 'public' | 'tunnel', waitSeconds: number) {
      const { event, res } = fakeEvent(requestOrigin)
      const state = { done: false, res, pending: Promise.resolve() as Promise<unknown> }
      state.pending = loadWithWait(event, { waitSeconds, userId: 'u', load: async () => 'running', settled: () => false }).finally(() => {
        state.done = true
      })
      return state
    }

    it('answers a tunnel request after 90 s at most', async () => {
      for (const waitSeconds of [91, 120, 3600]) {
        const wait = neverSettling('tunnel', waitSeconds)
        await vi.advanceTimersByTimeAsync(89_000)
        expect(wait.done, `wait=${waitSeconds}`).toBe(false)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(await wait.pending).toBe('running')
        expect(wait.res.headers['scantor-wait']).toBe('timeout')
      }
    })

    it('keeps shorter waits through the tunnel and the full wait of a public request', async () => {
      const short = neverSettling('tunnel', 30)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await short.pending).toBe('running')
      const full = neverSettling('public', 120)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(full.done).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await full.pending).toBe('running')
      expect(full.res.headers['scantor-wait']).toBe('timeout')
    })
  })

  it('does not wait at all once the shutdown began', async () => {
    await stopComponents(useLogger('test'))
    const { event, res } = fakeEvent()
    const started = Date.now()
    expect(await loadWithWait(event, { waitSeconds: 60, userId: 'u', load: async () => 'running', settled: () => false })).toBe('running')
    expect(res.headers['scantor-wait']).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(500)
  })
})
