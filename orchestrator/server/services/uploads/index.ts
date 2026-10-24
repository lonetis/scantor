import { createHash, randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { UploadKind } from '#shared/utils/enums'
import type { Page } from '#shared/types/common'
import type { Upload } from '#shared/types/uploads'
import type { UploadDoc } from '../../types/documents'
import { callerFilter, loadOwned } from '../../utils/authz'
import { ByteCap } from '../../utils/byte-cap'
import { apiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { findPage } from '../../utils/pagination'
import type { UserPrincipal } from '../../utils/principal'
import { copyObject, deleteObject, objectExists, uploadStream } from '../../utils/s3'
import { isoDate, isoDateOrNull } from '../../utils/serialize'

// Uploaded list files for templates (docs/api.md §4.9, docs/data-model.md §4.10, security.md WS-9): the body streams
// into a temporary S3 object under SCANTOR_MAX_UPLOAD_BYTES while its SHA-256 and non-empty lines are counted; it is
// never buffered whole, and a body over the cap is not read further (413). Uploads are de-duplicated per user by
// content hash and stored at `uploads/<userId>/<sha256>`.

export const UPLOAD_CONTENT_TYPES = ['text/plain', 'application/octet-stream'] as const

export function toApiUpload(doc: UploadDoc): Upload {
  return {
    id: doc._id,
    kind: doc.kind,
    name: doc.name,
    contentType: doc.contentType,
    bytes: doc.bytes,
    sha256: doc.sha256,
    lines: doc.lines,
    lastUsedAt: isoDateOrNull(doc.lastUsedAt),
    createdAt: isoDate(doc.createdAt),
  }
}

export function uploadKey(userId: string, sha256: string): string {
  return `uploads/${userId}/${sha256}`
}

/** The media type of an upload body, or 415 when it is not text/plain or application/octet-stream. */
export function uploadContentType(header: string | undefined): string {
  const type = (header ?? '').split(';')[0]!.trim().toLowerCase()
  if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(type)) {
    throw apiError('unsupportedMediaType', 'the upload body must be text/plain or application/octet-stream')
  }
  return type
}

/** Counts lines that contain anything besides ASCII whitespace, across chunk boundaries. */
export class LineCounter {
  lines = 0
  private current = false

  update(chunk: Buffer): void {
    for (const byte of chunk) {
      if (byte === 0x0a) {
        if (this.current) this.lines++
        this.current = false
      } else if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0b && byte !== 0x0c) {
        this.current = true
      }
    }
  }

  finish(): number {
    if (this.current) this.lines++
    this.current = false
    return this.lines
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000
}

export interface CreateUploadInput {
  body: Readable
  contentType: string
  name: string
  kind: UploadKind
  maxBytes: number
}

/** Streams an upload into S3. Returns the upload and whether it was created (false: identical content existed). */
export async function createUpload(principal: UserPrincipal, input: CreateUploadInput): Promise<{ upload: Upload; created: boolean }> {
  const userId = principal.user.id
  const log = useLogger('uploads')
  const tmpKey = `tmp/uploads/${randomUUID()}`
  const hash = createHash('sha256')
  const counter = new LineCounter()
  const cap = new ByteCap(input.maxBytes, (chunk) => {
    hash.update(chunk)
    counter.update(chunk)
  })
  // The request is piped, never destroyed: at the cap the pipe only pauses it, so the 413 still reaches the client.
  input.body.once('error', (error) => cap.destroy(error))
  try {
    await uploadStream(tmpKey, input.body.pipe(cap), input.contentType)
  } catch (error) {
    await deleteObject(tmpKey).catch((deleteError: unknown) => log.warn('deleting a temporary upload failed', { key: tmpKey, err: deleteError }))
    if (cap.exceeded) throw apiError('payloadTooLarge', `the upload exceeds ${input.maxBytes} bytes`, { limit: input.maxBytes })
    throw error
  }

  const bytes = cap.bytes
  const sha256 = hash.digest('hex')
  const lines = counter.finish()
  const { uploads } = useCollections()
  try {
    const existing = await uploads.findOne({ userId, sha256 })
    if (existing) return { upload: toApiUpload(existing), created: false }
    const key = uploadKey(userId, sha256)
    if (!(await objectExists(key))) await copyObject(tmpKey, key)
    const now = new Date()
    const doc: UploadDoc = {
      _id: randomUUID(),
      userId,
      kind: input.kind,
      name: input.name,
      contentType: input.contentType,
      bytes,
      sha256,
      lines,
      key,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await uploads.insertOne(doc)
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
      const raced = await uploads.findOne({ userId, sha256 })
      if (!raced) throw error
      return { upload: toApiUpload(raced), created: false }
    }
    return { upload: toApiUpload(doc), created: true }
  } finally {
    await deleteObject(tmpKey).catch((error: unknown) => log.warn('deleting a temporary upload failed', { key: tmpKey, err: error }))
  }
}

export async function listUploads(principal: UserPrincipal, query: { limit?: number; cursor?: string }): Promise<Page<Upload>> {
  return findPage(useCollections().uploads, callerFilter(principal), query, toApiUpload)
}

export async function getUpload(principal: UserPrincipal, uploadId: string): Promise<Upload> {
  return toApiUpload(await loadOwned(useCollections().uploads, uploadId, principal, { what: 'upload' }))
}

/** Deletes an upload unless a scan (any state but `deleted`) references it (409 uploadInUse). */
export async function deleteUpload(principal: UserPrincipal, uploadId: string): Promise<void> {
  const { uploads, scans } = useCollections()
  const doc = await loadOwned(uploads, uploadId, principal, { what: 'upload' })
  const inUse = await scans.findOne({ uploadIds: doc._id, state: { $ne: 'deleted' } }, { projection: { _id: 1 } })
  if (inUse) throw apiError('uploadInUse', `scan ${inUse._id} references this upload`, { scanId: inUse._id })
  await uploads.deleteOne({ _id: doc._id, userId: doc.userId })
  // Identical content of the same user shares the key; it is unique per user, so the object can go too.
  await deleteObject(doc.key)
}
