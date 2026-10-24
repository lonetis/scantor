import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UploadDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// Uploaded list files (docs/api.md §4.9, docs/data-model.md §4.10, security.md WS-9), with S3 replaced by a recorder
// that consumes the body like the multipart upload does.

const store = { uploads: new FakeCollection<UploadDoc>('uploads', [{ keys: ['userId', 'sha256'] }]) }
const s3 = { stored: new Map<string, Buffer>(), deleted: [] as string[] }

vi.mock('../../../server/utils/mongo', () => ({ useCollections: () => ({ uploads: store.uploads.asCollection() }) }))
vi.mock('../../../server/utils/s3', () => ({
  uploadStream: async (key: string, body: Readable) => {
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(chunk as Buffer)
    s3.stored.set(key, Buffer.concat(chunks))
  },
  objectExists: async (key: string) => s3.stored.has(key),
  copyObject: async (from: string, to: string) => {
    s3.stored.set(to, s3.stored.get(from)!)
  },
  deleteObject: async (key: string) => {
    s3.deleted.push(key)
    s3.stored.delete(key)
  },
}))

const { LineCounter, createUpload, listUploads, uploadContentType, uploadKey } = await import('../../../server/services/uploads')
const { ApiError } = await import('../../../server/utils/errors')
type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const user = { kind: 'user', user: { id: 'u1' }, isAdmin: false } as unknown as UserPrincipal
const admin = { kind: 'user', user: { id: 'a1' }, isAdmin: true } as unknown as UserPrincipal

/** A request-like body: `chunks` chunks of `size` bytes of `a\n` lines, produced on demand. */
function requestBody(chunks: number, size: number): Readable & { produced: number } {
  const body = new Readable({
    read() {
      if (body.produced >= chunks) {
        this.push(null)
        return
      }
      body.produced++
      this.push(Buffer.alloc(size, 'a\n'))
    },
  }) as Readable & { produced: number }
  body.produced = 0
  return body
}

beforeEach(() => {
  store.uploads.docs.length = 0
  s3.stored.clear()
  s3.deleted.length = 0
})

describe('listUploads', () => {
  it('lists only the caller’s own uploads, admins included (docs/api.md §1.3)', async () => {
    const mine = await createUpload(user, { body: requestBody(1, 10), contentType: 'text/plain', name: 'mine.txt', kind: 'list', maxBytes: 100 })
    const own = await createUpload(admin, { body: requestBody(1, 20), contentType: 'text/plain', name: 'own.txt', kind: 'list', maxBytes: 100 })
    expect((await listUploads(user, {})).items.map((item) => item.id)).toEqual([mine.upload.id])
    expect((await listUploads(admin, {})).items.map((item) => item.id)).toEqual([own.upload.id])
  })
})

describe('createUpload', () => {
  it('stores a body within the cap with its hash, size and line count', async () => {
    const { upload, created } = await createUpload(user, {
      body: requestBody(2, 1000),
      contentType: 'text/plain',
      name: 'list.txt',
      kind: 'list',
      maxBytes: 2000,
    })
    expect(created).toBe(true)
    expect(upload).toMatchObject({ name: 'list.txt', bytes: 2000, lines: 1000 })
    expect([...s3.stored.keys()]).toEqual([uploadKey('u1', upload.sha256)])
  })

  it('answers 413 above the cap without destroying the request, so the response still reaches the client', async () => {
    const body = requestBody(100, 64 * 1024)
    const error = await createUpload(user, { body, contentType: 'text/plain', name: 'big.txt', kind: 'list', maxBytes: 100 * 1024 }).catch(
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'payloadTooLarge', statusCode: 413, details: { limit: 100 * 1024 } })
    // Paused, not destroyed: destroying the request closes the socket, and Traefik then answers 502.
    expect(body.destroyed).toBe(false)
    expect(body.readableFlowing).toBe(false)
    // Not read further than the cap (plus what the stream buffers ahead).
    expect(body.produced).toBeLessThan(10)
    // Nothing stored: the temporary object is deleted, and no upload document exists.
    expect(s3.deleted).toHaveLength(1)
    expect(s3.stored.size).toBe(0)
    expect(store.uploads.docs).toHaveLength(0)
  })
})

describe('LineCounter', () => {
  it('counts non-empty lines across chunk boundaries', () => {
    const counter = new LineCounter()
    counter.update(Buffer.from('a.example\n\n  \nb.exa'))
    counter.update(Buffer.from('mple\r\n\t\nc'))
    expect(counter.finish()).toBe(3)
  })

  it('counts nothing for blank content', () => {
    const counter = new LineCounter()
    counter.update(Buffer.from('\n \n\r\n'))
    expect(counter.finish()).toBe(0)
  })
})

describe('uploads', () => {
  it('accepts text/plain and application/octet-stream only', () => {
    expect(uploadContentType('text/plain; charset=utf-8')).toBe('text/plain')
    expect(uploadContentType('application/octet-stream')).toBe('application/octet-stream')
    expect(() => uploadContentType('application/json')).toThrow(ApiError)
    expect(() => uploadContentType(undefined)).toThrow(ApiError)
  })

  it('keys uploads by owner and content hash', () => {
    expect(uploadKey('u1', 'ab12')).toBe('uploads/u1/ab12')
  })
})
