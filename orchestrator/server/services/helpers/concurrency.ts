// In-process concurrency primitives of the api component: a FIFO counting semaphore (helper slots, build slots), the
// same per key (the per-user helper slots) and a per-key read/write lock (the per-user workspace lock of
// docs/editor.md §9.8). All are fair: waiters are served in arrival order, and a waiting writer blocks later readers
// so it cannot starve.

export type Release = () => void

export class SemaphoreTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`no slot became free within ${waitedMs} ms`)
    this.name = 'SemaphoreTimeoutError'
  }
}

interface Waiter {
  grant: (release: Release) => void
  timer: NodeJS.Timeout | null
}

export class Semaphore {
  private active = 0
  private readonly queue: Waiter[] = []

  constructor(private capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`semaphore capacity must be a positive integer, got ${capacity}`)
  }

  get inUse(): number {
    return this.active
  }

  get waiting(): number {
    return this.queue.length
  }

  /** Changes the capacity (configuration is read at start; tests use it). */
  resize(capacity: number): void {
    this.capacity = capacity
    this.drain()
  }

  /**
   * Waits for a slot. Rejects with SemaphoreTimeoutError after `timeoutMs` (no timeout when omitted) and with the
   * signal's reason when `signal` aborts first.
   */
  acquire(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Release> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('aborted'))
    if (this.active < this.capacity && this.queue.length === 0) {
      this.active++
      return Promise.resolve(this.releaser())
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        timer: null,
        grant: (release) => {
          cleanup()
          resolve(release)
        },
      }
      const onAbort = () => {
        remove()
        reject(options.signal?.reason ?? new Error('aborted'))
      }
      const remove = () => {
        const index = this.queue.indexOf(waiter)
        if (index >= 0) this.queue.splice(index, 1)
        cleanup()
      }
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer)
        options.signal?.removeEventListener('abort', onAbort)
      }
      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          remove()
          reject(new SemaphoreTimeoutError(options.timeoutMs!))
        }, options.timeoutMs)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
    })
  }

  /** Runs `fn` while holding a slot. */
  async run<T>(fn: () => Promise<T>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const release = await this.acquire(options)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private releaser(): Release {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.capacity && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.active++
      next.grant(this.releaser())
    }
  }
}

/** A semaphore of `capacity` slots per key (a user id). Entries are dropped when idle. */
export class KeyedSemaphore {
  private readonly semaphores = new Map<string, Semaphore>()

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`semaphore capacity must be a positive integer, got ${capacity}`)
  }

  /** Number of keys with holders or waiters (for tests). */
  get size(): number {
    return this.semaphores.size
  }

  /** Slots of `key` in use. */
  inUse(key: string): number {
    return this.semaphores.get(key)?.inUse ?? 0
  }

  /** Waits for one of the key's slots, like Semaphore.acquire. */
  async acquire(key: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Release> {
    let semaphore = this.semaphores.get(key)
    if (!semaphore) {
      semaphore = new Semaphore(this.capacity)
      this.semaphores.set(key, semaphore)
    }
    const held = semaphore
    let release: Release
    try {
      release = await held.acquire(options)
    } catch (error) {
      this.dropIdle(key, held)
      throw error
    }
    let released = false
    return () => {
      if (released) return
      released = true
      release()
      this.dropIdle(key, held)
    }
  }

  private dropIdle(key: string, semaphore: Semaphore): void {
    if (semaphore.inUse === 0 && semaphore.waiting === 0 && this.semaphores.get(key) === semaphore) this.semaphores.delete(key)
  }
}

export type LockMode = 'shared' | 'exclusive'

interface LockState {
  readers: number
  writer: boolean
  queue: { mode: LockMode; grant: () => void }[]
}

/** A read/write lock per key (a user id). Entries are dropped when idle. */
export class KeyedRwLock {
  private readonly locks = new Map<string, LockState>()

  /** Number of keys with holders or waiters (for tests). */
  get size(): number {
    return this.locks.size
  }

  acquire(key: string, mode: LockMode): Promise<Release> {
    let state = this.locks.get(key)
    if (!state) {
      state = { readers: 0, writer: false, queue: [] }
      this.locks.set(key, state)
    }
    const lock = state
    return new Promise<Release>((resolve) => {
      const grant = () => {
        if (mode === 'exclusive') lock.writer = true
        else lock.readers++
        resolve(this.releaser(key, lock, mode))
      }
      if (lock.queue.length === 0 && this.compatible(lock, mode)) grant()
      else lock.queue.push({ mode, grant })
    })
  }

  async run<T>(key: string, mode: LockMode, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key, mode)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private compatible(lock: LockState, mode: LockMode): boolean {
    return mode === 'exclusive' ? !lock.writer && lock.readers === 0 : !lock.writer
  }

  private releaser(key: string, lock: LockState, mode: LockMode): Release {
    let released = false
    return () => {
      if (released) return
      released = true
      if (mode === 'exclusive') lock.writer = false
      else lock.readers--
      while (lock.queue.length > 0 && this.compatible(lock, lock.queue[0]!.mode)) {
        const next = lock.queue.shift()!
        next.grant()
        if (next.mode === 'exclusive') break
      }
      if (!lock.writer && lock.readers === 0 && lock.queue.length === 0) this.locks.delete(key)
    }
  }
}
