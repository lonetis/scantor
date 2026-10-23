import { createHash } from 'node:crypto'
import type { Page } from '#shared/types/common'
import type { Upload } from '#shared/types/uploads'
import { ok, type ApiClient } from '../helpers/api-client'
import { finishScanDeletion, settleScan, streamUpload, UNPLACEABLE_SETTINGS } from '../helpers/api-results'
import { expect, test as fixturesTest, unique } from '../fixtures'
import { apiResultsTest } from '../helpers/api-results-fixtures'

const test = apiResultsTest(fixturesTest)

// Uploaded list files (docs/api.md §4.9): raw bodies streamed into S3 under SCANTOR_MAX_UPLOAD_BYTES (100 MiB in the
// test stack), de-duplicated per user by content hash, referenced from configs and protected while a scan uses them.
// Every test uploads content that contains a unique() token, so tests of the same tenant never share an upload.

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

function createUpload(api: ApiClient, content: string | Buffer, options: { name?: string; contentType?: string; kind?: string } = {}) {
  return api.call<Upload>('createUpload', {
    body: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
    headers: { 'Content-Type': options.contentType ?? 'text/plain' },
    query: { name: options.name, kind: options.kind },
  })
}

async function listAllUploads(api: ApiClient): Promise<Upload[]> {
  const all: Upload[] = []
  let cursor: string | undefined
  do {
    const page = ok(await api.call<Page<Upload>>('listUploads', { query: { limit: 200, cursor } }), 'listUploads')
    all.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return all
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

test.describe('createUpload', () => {
  test('stores a raw body and counts its non-blank lines', { tag: ['@UPL-001'] }, async ({ api }) => {
    const token = unique('list')
    const content = `${token}-a\n\n   \nb\r\n\t\nc`
    const before = Date.now()
    const created = await createUpload(api, content, { name: 'targets.txt', kind: 'list' })
    expect(created.status).toBe(201)
    expect(created.body).toEqual({
      id: expect.any(String),
      kind: 'list',
      name: 'targets.txt',
      contentType: 'text/plain',
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
      lines: 3,
      lastUsedAt: null,
      createdAt: expect.any(String),
    })
    expect(Date.parse(created.body.createdAt)).toBeGreaterThanOrEqual(before - 5000)

    // application/octet-stream is accepted too; the name defaults to upload.txt and the kind to list.
    const binary = Buffer.from(`${token}\nsecond line`, 'utf8')
    const octet = await createUpload(api, binary, { contentType: 'application/octet-stream' })
    expect(octet.status).toBe(201)
    expect(octet.body).toMatchObject({ name: 'upload.txt', kind: 'list', contentType: 'application/octet-stream', bytes: binary.length, lines: 2 })

    // A charset parameter does not change the media type.
    const charset = await createUpload(api, `${token} with charset`, { contentType: 'text/plain; charset=utf-8' })
    expect(charset.status).toBe(201)
    expect(charset.body).toMatchObject({ contentType: 'text/plain', lines: 1 })
  })

  test('identical content returns the existing upload; another user gets their own', { tag: ['@UPL-002'] }, async ({ api, otherApi }) => {
    const content = `${unique('dedupe')}\nline two\n`
    const first = await createUpload(api, content, { name: 'first.txt' })
    expect(first.status).toBe(201)
    const again = await createUpload(api, content, { name: 'second.txt', contentType: 'application/octet-stream' })
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)

    const other = await createUpload(otherApi, content, { name: 'first.txt' })
    expect(other.status).toBe(201)
    expect(other.body.id).not.toBe(first.body.id)
    expect(other.body.sha256).toBe(first.body.sha256)
    ok(await otherApi.call('deleteUpload', { path: { uploadId: other.body.id } }), 'deleteUpload')
  })

  test('other media types are 415 and bodies above the cap are 413 without storing anything', { tag: ['@UPL-003'] }, async ({ api }) => {
    for (const contentType of ['application/json', 'text/csv', 'image/png', 'multipart/form-data; boundary=x']) {
      const response = await createUpload(api, `${unique('mt')}\n`, { contentType })
      expect(response.status, contentType).toBe(415)
      expect(response.body).toMatchObject({ error: { code: 'unsupportedMediaType' } })
    }

    const name = `${unique('too-large')}.txt`
    const before = new Set((await listAllUploads(api)).map((upload) => upload.id))
    const body = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x61)
    const tooLarge = await createUpload(api, body, { name })
    expect(tooLarge.status).toBe(413)
    expect(tooLarge.body).toMatchObject({ error: { code: 'payloadTooLarge', details: { limit: MAX_UPLOAD_BYTES } } })

    const after = await listAllUploads(api)
    expect(after.filter((upload) => upload.name === name)).toEqual([])
    expect(after.filter((upload) => !before.has(upload.id))).toEqual([])
  })

  // product bug: a streamed upload over SCANTOR_MAX_UPLOAD_BYTES gets 502 instead of 413
  test.fail(
    'a streamed body without Content-Length above the cap is 413 without storing anything',
    {
      tag: ['@UPL-003'],
      annotation: { type: 'issue', description: 'createUpload destroys the request socket at the cap, so Traefik answers 502 instead of 413' },
    },
    async ({ api, user }) => {
      const name = `${unique('streamed')}.txt`
      const before = new Set((await listAllUploads(api)).map((upload) => upload.id))
      const response = await streamUpload(user.apiKey, MAX_UPLOAD_BYTES + 1024 * 1024, name)
      const after = await listAllUploads(api)
      expect(after.filter((upload) => upload.name === name || !before.has(upload.id))).toEqual([])
      expect(response).toMatchObject({ status: 413 })
      expect(JSON.parse((response as { body: string }).body)).toMatchObject({ error: { code: 'payloadTooLarge', details: { limit: MAX_UPLOAD_BYTES } } })
    },
  )
})

test.describe('listUploads and getUpload', () => {
  test('pages through the caller’s own uploads only, admins included', { tag: ['@UPL-004'] }, async ({ api, otherApi, adminApi }) => {
    const token = unique('page')
    const created: Upload[] = []
    for (const n of [1, 2, 3]) created.push(ok(await createUpload(api, `${token}-${n}\n`, { name: `${token}-${n}.txt` }), 'createUpload'))

    // Newest first, two per page, without overlap.
    const first = ok(await api.call<Page<Upload>>('listUploads', { query: { limit: 2 } }), 'listUploads')
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = ok(await api.call<Page<Upload>>('listUploads', { query: { limit: 2, cursor: first.nextCursor! } }), 'listUploads')
    expect(second.items.map((item) => item.id)).not.toEqual(expect.arrayContaining(first.items.map((item) => item.id)))
    const all = await listAllUploads(api)
    const mine = all.filter((upload) => upload.name.startsWith(token))
    expect(mine.map((upload) => upload.id)).toEqual(created.map((upload) => upload.id).reverse())
    const times = all.map((upload) => Date.parse(upload.createdAt))
    expect(times).toEqual([...times].sort((a, b) => b - a))

    // Another user and the admin list only their own uploads.
    const ids = new Set(created.map((upload) => upload.id))
    expect((await listAllUploads(otherApi)).filter((upload) => ids.has(upload.id))).toEqual([])
    expect((await listAllUploads(adminApi)).filter((upload) => ids.has(upload.id))).toEqual([])

    const one = ok(await api.call<Upload>('getUpload', { path: { uploadId: created[0]!.id } }), 'getUpload')
    expect(one).toEqual(created[0])
    const foreign = await otherApi.call('getUpload', { path: { uploadId: created[0]!.id } })
    expect(foreign.status).toBe(404)
    expect(foreign.body).toMatchObject({ error: { code: 'notFound' } })
    for (const uploadId of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      expect((await api.call('getUpload', { path: { uploadId } })).status, uploadId).toBe(404)
    }
  })
})

test.describe('deleteUpload and scan references', () => {
  test('deletes an unused upload and its stored object', { tag: ['@UPL-005'] }, async ({ api }) => {
    const content = `${unique('delete')}\n`
    const created = ok(await createUpload(api, content), 'createUpload')
    const deleted = await api.call('deleteUpload', { path: { uploadId: created.id } })
    expect(deleted.status).toBe(204)
    expect(deleted.raw.length).toBe(0)
    expect((await api.call('getUpload', { path: { uploadId: created.id } })).status).toBe(404)
    expect((await api.call('deleteUpload', { path: { uploadId: created.id } })).status).toBe(404)
    // The content hash is free again: the same content is a new upload (201), not the old one (200).
    const again = await createUpload(api, content)
    expect(again.status).toBe(201)
    expect(again.body.id).not.toBe(created.id)
    ok(await api.call('deleteUpload', { path: { uploadId: again.body.id } }), 'deleteUpload')
  })
})

test.describe('uploads referenced by scans', () => {
  test(
    'a scan that references an upload sets lastUsedAt and keeps it from deletion until the scan is deleted',
    { tag: ['@UPL-005', '@UPL-006'] },
    async ({ api, resultset }) => {
      const upload = ok(await createUpload(api, `${unique('in-use')}\nsecond\n`), 'createUpload')
      expect(upload.lastUsedAt).toBeNull()

      const startedAt = Date.now()
      // The scan stays running without workers (no node matches); only its reference matters here.
      const scan = await resultset.start({ scanConfig: { items: ['a'], upload: upload.id }, settings: UNPLACEABLE_SETTINGS })
      expect(scan.uploadIds).toEqual([upload.id])
      const used = ok(await api.call<Upload>('getUpload', { path: { uploadId: upload.id } }), 'getUpload')
      expect(used.lastUsedAt).not.toBeNull()
      expect(Date.parse(used.lastUsedAt!)).toBeGreaterThanOrEqual(startedAt - 5000)

      const inUse = await api.call<{ error: { code: string; details: { scanId: string } } }>('deleteUpload', { path: { uploadId: upload.id } })
      expect(inUse.status).toBe(409)
      expect(inUse.body.error).toMatchObject({ code: 'uploadInUse', details: { scanId: scan.id } })

      // A cancelled scan and a deleting scan still reference it.
      ok(await api.cancelScan(scan.id), 'cancelScan')
      await settleScan(api, scan.id, 'cancelled', 60_000)
      expect((await api.call('deleteUpload', { path: { uploadId: upload.id } })).status).toBe(409)
      const deleting = ok(await api.deleteScan(scan.id), 'deleteScan')
      expect(deleting.scan.state).toBe('deleting')
      const whileDeleting = await api.call<{ error: { code: string; details: { scanId: string } } }>('deleteUpload', { path: { uploadId: upload.id } })
      expect(whileDeleting.status).toBe(409)
      expect(whileDeleting.body.error).toMatchObject({ code: 'uploadInUse', details: { scanId: scan.id } })

      // Once the scan is deleted the upload can go (the delete job's final step is applied directly, see
      // finishScanDeletion).
      await finishScanDeletion(scan.id)
      expect(ok(await api.getScan(scan.id), 'getScan').state).toBe('deleted')
      const removed = await api.call('deleteUpload', { path: { uploadId: upload.id } })
      expect(removed.status).toBe(204)
      expect((await api.call('getUpload', { path: { uploadId: upload.id } })).status).toBe(404)
    },
  )

  test('starting a scan with an unknown or foreign upload is 404', { tag: ['@UPL-006'] }, async ({ api, otherApi, resultset }) => {
    const { revision } = resultset
    const foreign = ok(await createUpload(otherApi, `${unique('foreign')}\n`), 'createUpload')
    try {
      for (const uploadId of [foreign.id, '00000000-0000-4000-8000-000000000000']) {
        const response = await api.startScan({ revision: revision.ref, scanConfig: { items: ['a'], upload: uploadId }, settings: UNPLACEABLE_SETTINGS })
        expect(response.status, uploadId).toBe(404)
        expect(response.body).toMatchObject({ error: { code: 'notFound' } })
      }
      const untouched = ok(await otherApi.call<Upload>('getUpload', { path: { uploadId: foreign.id } }), 'getUpload')
      expect(untouched.lastUsedAt).toBeNull()
    } finally {
      ok(await otherApi.call('deleteUpload', { path: { uploadId: foreign.id } }), 'deleteUpload')
    }
  })
})
