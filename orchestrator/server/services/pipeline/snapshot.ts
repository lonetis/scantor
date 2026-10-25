import { createHash, randomUUID } from 'node:crypto'
import { type Duplex, PassThrough, Writable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { apiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { copyObject, deleteObject, objectExists, uploadStream } from '../../utils/s3'
import { snapshotStream } from '../helpers/ops'

// Workspace snapshots into S3 (docs/architecture.md §11.1 step 6, docs/tasks.md §10): the `snapshot` helper streams
// the deterministic pack of a task folder into a temporary object `tmp/snapshots/<uuid>.tar.gz` while the
// orchestrator hashes the uncompressed stream and checks it against the helper's `summary.packSha256`. The pack is
// never parsed here; only its bytes are hashed. Publishing then copies it to the content-addressed key; test runs
// build from the temporary object and delete it. Whenever the snapshot fails, the upload body is torn down before the
// upload is awaited, so a helper that never ran or never exited cannot leave the S3 upload waiting for more bytes.

export const SNAPSHOT_CONTENT_TYPE = 'application/gzip'

export interface StoredSnapshot {
  /** `tmp/snapshots/<uuid>.tar.gz` */
  tmpKey: string
  packSha256: string
  /** size of the stored tar.gz */
  packBytes: number
  fileCount: number
  /** uncompressed bytes of the regular files */
  bytes: number
}

export function snapshotKey(taskId: string, packSha256: string): string {
  return `snapshots/${taskId}/${packSha256}.tar.gz`
}

/** A sink that forwards every chunk to two streams and counts the bytes; destroying it destroys both. */
class TeeSink extends Writable {
  bytes = 0
  constructor(private readonly targets: [Duplex, Duplex]) {
    super()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.bytes += chunk.length
    for (const target of this.targets) target.write(chunk)
    callback()
  }

  override _final(callback: (error?: Error | null) => void): void {
    for (const target of this.targets) target.end()
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // autoDestroy also lands here after a normal finish; the ended targets must then drain. Torn down early, the
    // targets are destroyed without an error, so their readers (the S3 upload, the hash) end with a premature close.
    if (!this.writableFinished) for (const target of this.targets) target.destroy()
    callback(error)
  }
}

/**
 * Streams a task folder's pack into a temporary S3 object and verifies its hash. `signal` (a test run's job) stops
 * the helper and the upload when it aborts.
 */
export async function snapshotToTmp(userId: string, taskName: string, signal?: AbortSignal): Promise<StoredSnapshot> {
  const log = useLogger('snapshots')
  const tmpKey = `tmp/snapshots/${randomUUID()}.tar.gz`
  const uploadBody = new PassThrough()
  const gunzip = createGunzip()
  const hash = createHash('sha256')
  const hashed = new Promise<string>((resolve, reject) => {
    gunzip.on('data', (chunk: Buffer) => hash.update(chunk))
    gunzip.on('end', () => resolve(hash.digest('hex')))
    gunzip.on('error', reject)
  })
  // Partial output of a failed helper must not become an unhandled rejection.
  hashed.catch(() => undefined)
  const sink = new TeeSink([uploadBody, gunzip])
  const uploaded = uploadStream(tmpKey, uploadBody, SNAPSHOT_CONTENT_TYPE)
  uploaded.catch(() => undefined)
  try {
    const summary = await snapshotStream(userId, taskName, sink, signal)
    await uploaded
    const packSha256 = await hashed.catch((error: unknown) => {
      throw apiError('internal', `the workspace snapshot is not a valid gzip stream: ${(error as Error).message}`)
    })
    if (packSha256 !== summary.packSha256) {
      log.error('workspace snapshot hash mismatch', { userId, task: taskName, expected: summary.packSha256, actual: packSha256 })
      throw apiError('internal', 'the workspace snapshot does not match its reported pack hash')
    }
    return { tmpKey, packSha256, packBytes: sink.bytes, fileCount: summary.fileCount, bytes: summary.bytes }
  } catch (error) {
    // The body belongs to this function: destroying it makes the upload reject (and abort a multipart upload) when
    // the helper never ended its output.
    uploadBody.destroy()
    gunzip.destroy()
    await uploaded.catch(() => undefined)
    await deleteObject(tmpKey).catch((deleteError: unknown) => log.warn('deleting a temporary snapshot failed', { key: tmpKey, err: deleteError }))
    throw error
  }
}

/**
 * Moves a temporary snapshot to `snapshots/<taskId>/<packSha256>.tar.gz` (the copy is skipped when that immutable
 * key already exists) and deletes the temporary object. Leftovers of a crash expire through the `tmp/` lifecycle.
 */
export async function promoteSnapshot(snapshot: StoredSnapshot, taskId: string): Promise<string> {
  const key = snapshotKey(taskId, snapshot.packSha256)
  if (!(await objectExists(key))) await copyObject(snapshot.tmpKey, key)
  await discardTmpSnapshot(snapshot)
  return key
}

export async function discardTmpSnapshot(snapshot: Pick<StoredSnapshot, 'tmpKey'>): Promise<void> {
  try {
    await deleteObject(snapshot.tmpKey)
  } catch (error) {
    useLogger('snapshots').warn('deleting a temporary snapshot failed', { key: snapshot.tmpKey, err: error })
  }
}
