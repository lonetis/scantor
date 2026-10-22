import { describe, expect, it } from 'vitest'
import type { LockDoc } from '../../server/types/documents'
import { LeaseLock, LOCK_LEASE_MS, releaseLock, tryAcquireLock, withLock } from '../../server/utils/locks'
import { FakeCollection } from '../helpers/fake-collection'

// Lease locks (docs/data-model.md §4.13).

describe('lease locks', () => {
  it('lets one owner hold a lock until it expires or is released', async () => {
    const locks = new FakeCollection<LockDoc>('locks')
    const collection = locks.asCollection()
    expect(await tryAcquireLock(collection, 'reconciler', 'a')).toBe(true)
    expect(await tryAcquireLock(collection, 'reconciler', 'a')).toBe(true)
    expect(await tryAcquireLock(collection, 'reconciler', 'b')).toBe(false)
    expect(locks.docs[0]).toMatchObject({ _id: 'reconciler', owner: 'a' })

    await releaseLock(collection, 'reconciler', 'b')
    expect(locks.docs).toHaveLength(1)
    await releaseLock(collection, 'reconciler', 'a')
    expect(locks.docs).toHaveLength(0)
    expect(await tryAcquireLock(collection, 'reconciler', 'b')).toBe(true)
  })

  it('lets another owner take over an expired lease', async () => {
    const locks = new FakeCollection<LockDoc>('locks')
    locks.docs.push({ _id: 'gc', owner: 'dead', acquiredAt: new Date(0), expiresAt: new Date(Date.now() - 1) })
    expect(await tryAcquireLock(locks.asCollection(), 'gc', 'b')).toBe(true)
    expect(locks.docs[0]).toMatchObject({ owner: 'b', acquiredAt: new Date(0) })
    expect((locks.docs[0]!.expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + LOCK_LEASE_MS - 1000)
  })

  it('withLock runs exclusively and releases afterwards', async () => {
    const locks = new FakeCollection<LockDoc>('locks')
    const result = await withLock(locks.asCollection(), 'migrations', async () => {
      expect(await tryAcquireLock(locks.asCollection(), 'migrations', 'someone-else')).toBe(false)
      return 42
    })
    expect(result).toBe(42)
    expect(locks.docs).toHaveLength(0)
  })

  it('withLock gives up when another instance keeps the lock', async () => {
    const locks = new FakeCollection<LockDoc>('locks')
    await tryAcquireLock(locks.asCollection(), 'migrations', 'other')
    await expect(withLock(locks.asCollection(), 'migrations', async () => 1, { waitMs: 20, pollMs: 5 })).rejects.toThrow('held by another')
  })

  it('LeaseLock reports acquisition and release', async () => {
    const locks = new FakeCollection<LockDoc>('locks')
    let acquired = 0
    const lease = new LeaseLock(locks.asCollection(), 'reconciler', { onAcquired: () => acquired++ })
    lease.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(lease.held).toBe(true)
    expect(acquired).toBe(1)
    await lease.stop()
    expect(lease.held).toBe(false)
    expect(locks.docs).toHaveLength(0)
  })
})
