import { randomBytes } from 'node:crypto'
import { DeleteBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Config, parseConfig, setConfigForTesting } from '../../server/utils/config'
import { useLogger } from '../../server/utils/logger'
import { deletePrefix, ensureBucket, presignPut, useS3 } from '../../server/utils/s3'

/*
 * Presigned PUTs against RustFS (docs/data-model.md §9, docs/api.md §8.3): Content-Type, Content-Length and the
 * object metadata are signed headers, and the uploader sends exactly the returned headers. RustFS ignores metadata
 * hoisted into the query string and refuses unsigned x-amz-meta-* headers, so the metadata must be signed.
 *
 * Opt-in: SCANTOR_TEST_INTEGRATION=true plus SCANTOR_S3_INTERNAL_URL, SCANTOR_S3_ACCESS_KEY and
 * SCANTOR_S3_SECRET_KEY of a throwaway RustFS. The run uses its own bucket and removes it.
 */

const enabled = process.env.SCANTOR_TEST_INTEGRATION === 'true'
const suffix = randomBytes(4).toString('hex')
let config: Config

describe.skipIf(!enabled)('presigned PUTs against RustFS', () => {
  beforeAll(async () => {
    config = parseConfig({ ...process.env, SCANTOR_S3_BUCKET: `scantor-it-${suffix}` }).config
    setConfigForTesting(config)
    await ensureBucket(useLogger('it'))
  })

  afterAll(async () => {
    if (!enabled) return
    await deletePrefix('files/')
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
})
