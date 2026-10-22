import { describe, expect, it } from 'vitest'
import { KeyedRwLock, Semaphore, SemaphoreTimeoutError } from '../../../server/services/helpers/concurrency'

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
