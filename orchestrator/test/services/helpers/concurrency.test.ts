import { describe, expect, it } from 'vitest'
import { KeyedRwLock, KeyedSemaphore, Semaphore, SemaphoreTimeoutError } from '../../../server/services/helpers/concurrency'

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('Semaphore', () => {
  it('grants up to its capacity and serves waiters FIFO', async () => {
    const semaphore = new Semaphore(2)
    const order: number[] = []
    const a = await semaphore.acquire()
    const b = await semaphore.acquire()
    const waiting = [1, 2].map((n) => semaphore.acquire().then((release) => order.push(n) && release))
    await tick()
    expect(semaphore.waiting).toBe(2)
    a()
    await tick()
    b()
    await Promise.all(waiting)
    expect(order).toEqual([1, 2])
  })

  it('times out waiters', async () => {
    const semaphore = new Semaphore(1)
    const release = await semaphore.acquire()
    await expect(semaphore.acquire({ timeoutMs: 10 })).rejects.toBeInstanceOf(SemaphoreTimeoutError)
    expect(semaphore.waiting).toBe(0)
    release()
    expect(semaphore.inUse).toBe(0)
  })

  it('rejects on abort and ignores double releases', async () => {
    const semaphore = new Semaphore(1)
    const release = await semaphore.acquire()
    const controller = new AbortController()
    const waiting = semaphore.acquire({ signal: controller.signal })
    controller.abort(new Error('stop'))
    await expect(waiting).rejects.toThrow('stop')
    release()
    release()
    expect(semaphore.inUse).toBe(0)
  })
})

describe('KeyedSemaphore', () => {
  it('caps each key separately and drops idle keys', async () => {
    const slots = new KeyedSemaphore(2)
    const a1 = await slots.acquire('a')
    const a2 = await slots.acquire('a')
    const b1 = await slots.acquire('b')
    expect(slots.inUse('a')).toBe(2)
    expect(slots.inUse('b')).toBe(1)
    await expect(slots.acquire('a', { timeoutMs: 10 })).rejects.toBeInstanceOf(SemaphoreTimeoutError)
    const waiting = slots.acquire('a')
    a1()
    a1()
    const a3 = await waiting
    expect(slots.inUse('a')).toBe(2)
    for (const release of [a2, a3, b1]) release()
    expect(slots.size).toBe(0)
  })

  it('drops the key of an aborted waiter', async () => {
    const slots = new KeyedSemaphore(1)
    const held = await slots.acquire('a')
    const abort = new AbortController()
    const waiting = slots.acquire('a', { signal: abort.signal })
    abort.abort(new Error('gone'))
    await expect(waiting).rejects.toThrow('gone')
    held()
    expect(slots.size).toBe(0)
  })
})

describe('KeyedRwLock', () => {
  it('lets readers share, writers exclude, and a waiting writer block later readers', async () => {
    const lock = new KeyedRwLock()
    const events: string[] = []
    const r1 = await lock.acquire('u', 'shared')
    const r2 = await lock.acquire('u', 'shared')
    const writer = lock.acquire('u', 'exclusive').then((release) => {
      events.push('writer')
      return release
    })
    const lateReader = lock.acquire('u', 'shared').then((release) => {
      events.push('reader')
      return release
    })
    await tick()
    expect(events).toEqual([])
    r1()
    r2()
    const releaseWriter = await writer
    await tick()
    expect(events).toEqual(['writer'])
    releaseWriter()
    ;(await lateReader)()
    expect(events).toEqual(['writer', 'reader'])
    expect(lock.size).toBe(0)
  })

  it('keeps keys independent', async () => {
    const lock = new KeyedRwLock()
    const a = await lock.acquire('a', 'exclusive')
    const b = await lock.acquire('b', 'exclusive')
    a()
    b()
    expect(lock.size).toBe(0)
  })
})
