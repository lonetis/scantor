import { createHash } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotSummary } from '../../../server/services/helpers/types'

// snapshotToTmp (docs/tasks.md §10): the helper's pack streams into a temporary S3 object while its uncompressed bytes
// are hashed. A helper that fails without ending its output (no free slot, a timeout, a Docker error) must not leave
// the upload waiting for more bytes.

const uploads: { key: string; bytes: number; settled: 'done' | 'failed' | null }[] = []
const deleted: string[] = []
let helper: (sink: Writable, signal?: AbortSignal) => Promise<SnapshotSummary>

vi.mock('../../../server/services/helpers/ops', () => ({
  snapshotStream: (_userId: string, _task: string, sink: Writable, signal?: AbortSignal) => helper(sink, signal),
}))
vi.mock('../../../server/utils/s3', () => ({
  // Reads the body like lib-storage's Upload: it settles only when the body ends or fails.
  uploadStream: async (key: string, body: Readable) => {
    const upload = { key, bytes: 0, settled: null as 'done' | 'failed' | null }
    uploads.push(upload)
    try {
      for await (const chunk of body) upload.bytes += (chunk as Buffer).length
      upload.settled = 'done'
    } catch (error) {
      upload.settled = 'failed'
      throw error
    }
  },
  deleteObject: async (key: string) => {
    deleted.push(key)
  },
  copyObject: async () => undefined,
  objectExists: async () => false,
}))

const { snapshotToTmp } = await import('../../../server/services/pipeline/snapshot')
const { apiError } = await import('../../../server/utils/errors')

const PACK = Buffer.from('a deterministic tar stream')
const PACK_SHA256 = createHash('sha256').update(PACK).digest('hex')
const GZIPPED = gzipSync(PACK)

function summary(packSha256 = PACK_SHA256): SnapshotSummary {
  return { packSha256, fileCount: 2, bytes: PACK.length, packBytes: GZIPPED.length }
}

/** Rejects when `promise` has not settled within `ms` (a hang fails the test instead of timing it out). */
function within<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))])
}

beforeEach(() => {
  uploads.length = 0
  deleted.length = 0
})

describe('snapshotToTmp', () => {
  it('stores the pack and returns its verified hash', async () => {
    helper = async (sink) => {
      sink.end(GZIPPED)
      return summary()
    }
    const stored = await within(snapshotToTmp('u1', 'echo'))
    expect(stored).toMatchObject({ packSha256: PACK_SHA256, packBytes: GZIPPED.length, fileCount: 2, bytes: PACK.length })
    expect(stored.tmpKey).toMatch(/^tmp\/snapshots\/[0-9a-f-]{36}\.tar\.gz$/)
    expect(uploads).toEqual([{ key: stored.tmpKey, bytes: GZIPPED.length, settled: 'done' }])
    expect(deleted).toEqual([])
  })

  it('rejects and deletes the temporary object when the helper fails without ending its output', async () => {
    const failure = apiError('unavailable', 'no workspace helper slot became free within 30 s; retry later')
    helper = async (sink) => {
      sink.write(GZIPPED.subarray(0, 8))
      throw failure
    }
    await expect(within(snapshotToTmp('u1', 'echo'))).rejects.toBe(failure)
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.settled).toBe('failed')
    expect(deleted).toEqual([uploads[0]!.key])
  })

  it('rejects when the helper fails before writing anything', async () => {
    helper = async () => {
      throw new Error('the Docker daemon is not reachable')
    }
    await expect(within(snapshotToTmp('u1', 'echo'))).rejects.toThrow('the Docker daemon is not reachable')
    expect(uploads[0]!.settled).toBe('failed')
    expect(deleted).toEqual([uploads[0]!.key])
  })

  it('passes the signal to the helper and stops when it aborts', async () => {
    const abort = new AbortController()
    let seen: AbortSignal | undefined
    helper = (sink, signal) => {
      seen = signal
      sink.write(GZIPPED.subarray(0, 4))
      return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    }
    const pending = snapshotToTmp('u1', 'echo', abort.signal)
    abort.abort(new Error('cancelled'))
    await expect(within(pending)).rejects.toThrow('cancelled')
    expect(seen).toBe(abort.signal)
    expect(uploads[0]!.settled).toBe('failed')
  })

  it('refuses a pack whose hash differs from the reported one', async () => {
    helper = async (sink) => {
      sink.end(GZIPPED)
      return summary('0'.repeat(64))
    }
    await expect(within(snapshotToTmp('u1', 'echo'))).rejects.toMatchObject({ code: 'internal' })
    expect(deleted).toEqual([uploads[0]!.key])
  })
})
