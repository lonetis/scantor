import { randomBytes } from 'node:crypto'
import { DeleteBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Config, parseConfig, setConfigForTesting } from '../../server/utils/config'
import { useLogger } from '../../server/utils/logger'
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deletePrefix,
  ensureBucket,
  getObjectRange,
  headObject,
  isS3NotFound,
  presignInternalGet,
  presignPut,
  presignUploadPart,
  putObject,
  s3ErrorCode,
  useS3,
} from '../../server/utils/s3'

/*
 * Presigned PUTs against RustFS (docs/data-model.md §9, docs/api.md §8.3): Content-Type, Content-Length and the
 * object metadata are signed headers, and the uploader sends exactly the returned headers. RustFS ignores metadata
 * hoisted into the query string and refuses unsigned x-amz-meta-* headers, so the metadata must be signed. Range
 * reads (docs/api.md §4.15) return exactly the requested bytes. The fast presigned GETs of the script runtime API and
 * the multipart uploads of script-run outputs (docs/scripts.md) work against RustFS as they do against the SDK.
 *
 * Opt-in: SCANTOR_TEST_INTEGRATION=true plus SCANTOR_S3_INTERNAL_URL, SCANTOR_S3_ACCESS_KEY and
 * SCANTOR_S3_SECRET_KEY of a throwaway RustFS. The run uses its own bucket and removes it.
 */

const enabled = process.env.SCANTOR_TEST_INTEGRATION === 'true'
const suffix = randomBytes(4).toString('hex')
let config: Config

describe.skipIf(!enabled)('presigned PUTs and range reads against RustFS', () => {
  beforeAll(async () => {
    config = parseConfig({ ...process.env, SCANTOR_S3_BUCKET: `scantor-it-${suffix}` }).config
    setConfigForTesting(config)
    await ensureBucket(useLogger('it'))
  })

  afterAll(async () => {
    if (!enabled) return
    await deletePrefix('files/')
    await deletePrefix('script-runs/')
    await useS3().send(new DeleteBucketCommand({ Bucket: config.s3Bucket }))
    setConfigForTesting(null)
  })

  it('stores the object with its signed metadata when the returned headers are sent', async () => {
    const content = Buffer.from('{"ok":true}')
    const key = `files/${suffix}/report.json`
    const signed = await presignPut({
      key,
      contentType: 'application/json',
      contentLength: content.length,
      expiresInSeconds: 300,
      profile: 'internal',
      metadata: { 'file-id': 'f1', name: encodeURIComponent('rapport final.json') },
    })
    const { 'x-amz-meta-name': _name, ...withoutName } = signed.headers
    expect((await fetch(signed.url, { method: 'PUT', headers: withoutName, body: content })).status).toBe(403)
    expect((await fetch(signed.url, { method: 'PUT', headers: { ...signed.headers, 'x-amz-meta-name': 'other' }, body: content })).status).toBe(403)
    expect((await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: content })).status).toBe(200)
    const head = await useS3().send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }))
    expect(head).toMatchObject({ ContentLength: content.length, ContentType: 'application/json' })
    expect(head.Metadata).toEqual({ 'file-id': 'f1', name: 'rapport%20final.json' })
  })

  it('reads byte ranges of an object with getObjectRange', async () => {
    const key = `files/${suffix}/range.bin`
    const content = Buffer.from('0123456789abcdef')
    await putObject(key, content, 'application/octet-stream')
    expect((await getObjectRange(key, 0, 3)).toString()).toBe('0123')
    expect((await getObjectRange(key, 5, 9)).toString()).toBe('56789')
    expect((await getObjectRange(key, 12, 100)).toString()).toBe('cdef')
    expect((await getObjectRange(key, 0, content.length - 1)).equals(content)).toBe(true)
    expect(isS3NotFound(await getObjectRange(`files/${suffix}/missing.bin`, 0, 1).catch((error: unknown) => error))).toBe(true)
  })

  it('serves objects with any key through presignInternalGet and refuses tampered or expired URLs', async () => {
    const content = Buffer.from('fast signer')
    for (const name of ['a b+c%d~e.txt', 'ünïcödé-名前.json', "x!'()*@;=,$&.bin"]) {
      const key = `files/${suffix}/sig/${name}`
      await putObject(key, content, 'text/plain')
      const { url } = presignInternalGet(key, 300)
      const response = await fetch(url, { redirect: 'manual' })
      expect(response.status, name).toBe(200)
      expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(true)
      const tampered = url.replace(/X-Amz-Signature=([0-9a-f])/, (_match, first: string) => `X-Amz-Signature=${first === '0' ? '1' : '0'}`)
      expect((await fetch(tampered)).status).toBe(403)
    }
    const key = `files/${suffix}/sig/expiring.txt`
    await putObject(key, content, 'text/plain')
    const { url } = presignInternalGet(key, 1, new Date(Date.now() - 5000))
    expect((await fetch(url)).status).toBe(403)
  })

  it('stores a multipart output from presigned parts with signed Content-Length', async () => {
    const key = `script-runs/${suffix}/outputs/o1/out.csv`
    const uploadId = await createMultipartUpload(key, 'text/csv', { 'output-id': 'o1', name: 'out.csv' })
    const first = Buffer.alloc(5 * 1024 * 1024, 'a')
    const last = Buffer.from('tail\n')
    const etags: string[] = []
    for (const [index, body] of [first, last].entries()) {
      const part = await presignUploadPart({ key, uploadId, partNumber: index + 1, contentLength: body.length, expiresInSeconds: 300, profile: 'internal' })
      if (index === 1) {
        // A body of another size than the presigned Content-Length is refused.
        expect(
          (await fetch(part.url, { method: 'PUT', headers: { 'Content-Length': String(body.length + 1) }, body: Buffer.concat([body, Buffer.from('x')]) })).ok,
        ).toBe(false)
      }
      const response = await fetch(part.url, { method: 'PUT', headers: part.headers, body })
      expect(response.status).toBe(200)
      etags.push(response.headers.get('etag')!)
    }
    await completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etags[1]! },
      { partNumber: 1, etag: etags[0]! },
    ])
    expect(await headObject(key)).toMatchObject({ size: first.length + last.length, contentType: 'text/csv', metadata: { 'output-id': 'o1', name: 'out.csv' } })
    const downloaded = Buffer.from(await (await fetch(presignInternalGet(key, 300).url)).arrayBuffer())
    expect(downloaded.equals(Buffer.concat([first, last]))).toBe(true)
    expect(await headObject(`script-runs/${suffix}/outputs/missing`)).toBeNull()
  })

  it('aborts a multipart upload, after which it cannot be completed', async () => {
    const key = `script-runs/${suffix}/outputs/o2/aborted.bin`
    const uploadId = await createMultipartUpload(key, 'application/octet-stream')
    const part = await presignUploadPart({ key, uploadId, partNumber: 1, contentLength: 3, expiresInSeconds: 300, profile: 'internal' })
    const response = await fetch(part.url, { method: 'PUT', headers: part.headers, body: Buffer.from('abc') })
    expect(response.status).toBe(200)
    await abortMultipartUpload(key, uploadId)
    await abortMultipartUpload(key, uploadId)
    const error = await completeMultipartUpload(key, uploadId, [{ partNumber: 1, etag: response.headers.get('etag')! }]).catch((thrown: unknown) => thrown)
    expect(s3ErrorCode(error)).toBe('NoSuchUpload')
    expect(await headObject(key)).toBeNull()
  })
})
