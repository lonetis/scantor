import { createHash, createHmac } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { EndpointProfile } from '#shared/utils/enums'
import { type Config, useConfig } from './config'
import { type Logger, useLogger } from './logger'

// RustFS (S3) access (docs/data-model.md §9, docs/architecture.md §8, §11.5). The orchestrator talks to the
// internal endpoint with the root keys; presigned URLs are signed offline for the endpoint of the consumer:
// `internal` (built-in node workers) or `public` (browsers, remote nodes). Checksums are calculated only when an
// operation requires them, so presigned PUTs carry no checksum parameters the uploader cannot reproduce.

export const DOWNLOAD_URL_TTL_SECONDS = 600
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** The region every client signs for (RustFS accepts any; presigned URLs must agree with the SDK's). */
const S3_REGION = 'us-east-1'

const clients = new Map<string, S3Client>()

function createS3Client(endpoint: string, config: Config): S3Client {
  return new S3Client({
    endpoint,
    region: S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

function clientFor(endpoint: string): S3Client {
  let client = clients.get(endpoint)
  if (!client) {
    client = createS3Client(endpoint, useConfig())
    clients.set(endpoint, client)
  }
  return client
}

/** The client of the internal endpoint, used for every operation the orchestrator performs itself. */
export function useS3(): S3Client {
  return clientFor(useConfig().s3InternalUrl)
}

/** The endpoint presigned URLs are signed for (the Host header must reach RustFS unchanged). */
export function s3EndpointFor(profile: EndpointProfile): string {
  const config = useConfig()
  return profile === 'internal' ? config.s3InternalUrl : config.s3PublicUrl
}

export function s3Bucket(): string {
  return useConfig().s3Bucket
}

// ── names ───────────────────────────────────────────────────────────────────

/**
 * The sanitised last key segment of a user-supplied name (docs/data-model.md §9): NFC, characters outside
 * `[A-Za-z0-9._-]` replaced by `_`, at most 128 characters, never `.` or `..`, never empty.
 */
export function safeName(name: string): string {
  let result = name.normalize('NFC').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  if (result === '' || result === '.' || result === '..') result = result.replaceAll('.', '_') || '_'
  return result
}

/** `Content-Disposition` with an RFC 5987 `filename*` (and an ASCII fallback). */
export function contentDisposition(disposition: 'attachment' | 'inline', name: string): string {
  const ascii = safeName(name).replaceAll('"', '_')
  const encoded = encodeURIComponent(name.normalize('NFC').replace(/[\r\n"]/g, '_')).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

// ── presigning ──────────────────────────────────────────────────────────────

export interface PresignPutOptions {
  key: string
  contentType: string
  contentLength: number
  expiresInSeconds: number
  profile: EndpointProfile
  /** Object metadata (`x-amz-meta-<name>`); values must be ASCII. */
  metadata?: Record<string, string>
}

export interface PresignedPut {
  url: string
  /** Every header the uploader must send, exactly as given. */
  headers: Record<string, string>
  expiresAt: Date
}

/**
 * A presigned PUT whose `Content-Type`, `Content-Length` and metadata are signed headers: the uploader must send
 * exactly the returned headers. Metadata is never hoisted into the query string, because RustFS ignores hoisted
 * `x-amz-meta-*` parameters and refuses unsigned `x-amz-meta-*` headers (verified on rustfs 1.0.3).
 */
export async function presignPut(options: PresignPutOptions): Promise<PresignedPut> {
  const metadataHeaders = Object.fromEntries(Object.entries(options.metadata ?? {}).map(([name, value]) => [`x-amz-meta-${name.toLowerCase()}`, value]))
  const command = new PutObjectCommand({
    Bucket: s3Bucket(),
    Key: options.key,
    ContentType: options.contentType,
    ContentLength: options.contentLength,
    Metadata: options.metadata,
  })
  const url = await getSignedUrl(clientFor(s3EndpointFor(options.profile)), command, {
    expiresIn: options.expiresInSeconds,
    signableHeaders: new Set(['content-type', 'content-length', ...Object.keys(metadataHeaders)]),
    unhoistableHeaders: new Set(Object.keys(metadataHeaders)),
  })
  return {
    url,
    headers: { 'Content-Type': options.contentType, 'Content-Length': String(options.contentLength), ...metadataHeaders },
    expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
  }
}

export interface PresignGetOptions {
  key: string
  expiresInSeconds: number
  profile: EndpointProfile
  responseContentType?: string
  responseContentDisposition?: string
}

export async function presignGet(options: PresignGetOptions): Promise<{ url: string; expiresAt: Date }> {
  const command = new GetObjectCommand({
    Bucket: s3Bucket(),
    Key: options.key,
    ResponseContentType: options.responseContentType,
    ResponseContentDisposition: options.responseContentDisposition,
  })
  const url = await getSignedUrl(clientFor(s3EndpointFor(options.profile)), command, { expiresIn: options.expiresInSeconds })
  return { url, expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000) }
}

// ── fast presigned GETs for the internal endpoint ──────────────────────────

/** The longest validity SigV4 allows for a presigned URL (7 days). */
const SIGV4_MAX_EXPIRES_SECONDS = 604_800
const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256'
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

/** RFC 3986 escaping as the SDK applies it to path segments and query values (`encodeURIComponent` plus `!'()*`). */
function uriEscape(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** `20260102T030405Z`: the ISO 8601 basic format of SigV4. */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

let signingKeyCache: { secret: string; dateStamp: string; key: Buffer } | null = null
let endpointCache: { url: string; origin: string; host: string } | null = null

/** Origin and Host header of the internal endpoint (the URL is parsed once). */
function internalEndpoint(url: string): { origin: string; host: string } {
  if (endpointCache?.url !== url) {
    const parsed = new URL(url)
    endpointCache = { url, origin: parsed.origin, host: parsed.host }
  }
  return endpointCache
}

/** The SigV4 signing key of one day (HMAC chain over date, region, service), cached until the date changes. */
function signingKey(secret: string, dateStamp: string): Buffer {
  if (signingKeyCache?.secret === secret && signingKeyCache.dateStamp === dateStamp) return signingKeyCache.key
  const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest()
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), S3_REGION), 's3'), 'aws4_request')
  signingKeyCache = { secret, dateStamp, key }
  return key
}

/**
 * A presigned GET of an object for SCANTOR_S3_INTERNAL_URL, signed in-process without the SDK (about 3 µs instead of
 * about 90 µs per URL; the script runtime API signs one URL per stored file it streams). The URL is byte-identical
 * to the one the SDK presigner produces for the same key, clock and validity (test/utils/s3.test.ts): path-style
 * `/<bucket>/<key>`, only `host` signed, an unsigned payload, `x-id=GetObject`. No response overrides. Callers pass
 * the key of a stored FileRef or output, never one built from input (docs/scripts.md, security.md).
 */
export function presignInternalGet(key: string, ttlSeconds: number, now: Date = new Date()): { url: string; expiresAt: Date } {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > SIGV4_MAX_EXPIRES_SECONDS) {
    throw new Error(`invalid presigned URL validity ${ttlSeconds}s`)
  }
  const config = useConfig()
  const endpoint = internalEndpoint(config.s3InternalUrl)
  const date = amzDate(now)
  const dateStamp = date.slice(0, 8)
  const scope = `${dateStamp}/${S3_REGION}/s3/aws4_request`
  const path = `/${config.s3Bucket}/${key.split('/').map(uriEscape).join('/')}`
  // Sorted by name in byte order, as SigV4 requires; X-Amz-Signature joins between X-Amz-Expires and X-Amz-SignedHeaders.
  const head = [
    `X-Amz-Algorithm=${SIGV4_ALGORITHM}`,
    `X-Amz-Content-Sha256=${UNSIGNED_PAYLOAD}`,
    `X-Amz-Credential=${uriEscape(`${config.s3AccessKey}/${scope}`)}`,
    `X-Amz-Date=${date}`,
    `X-Amz-Expires=${ttlSeconds}`,
  ].join('&')
  const tail = 'X-Amz-SignedHeaders=host&x-id=GetObject'
  const canonicalRequest = `GET\n${path}\n${head}&${tail}\nhost:${endpoint.host}\n\nhost\n${UNSIGNED_PAYLOAD}`
  const stringToSign = `${SIGV4_ALGORITHM}\n${date}\n${scope}\n${createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')}`
  const signature = createHmac('sha256', signingKey(config.s3SecretKey, dateStamp)).update(stringToSign, 'utf8').digest('hex')
  return {
    url: `${endpoint.origin}${path}?${head}&X-Amz-Signature=${signature}&${tail}`,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
  }
}

/**
 * A browser download of an object (security.md DL-1): an attachment with `application/octet-stream`, except
 * png/jpeg/gif/webp images, which are served inline with their forced image type. Valid 10 minutes, created per
 * request, always for SCANTOR_S3_PUBLIC_URL.
 */
export async function presignDownload(options: {
  key: string
  name: string
  contentType: string
  attachmentType?: string
}): Promise<{ url: string; expiresAt: Date; inline: boolean }> {
  const type = options.contentType.split(';')[0]!.trim().toLowerCase()
  const inline = INLINE_IMAGE_TYPES.has(type)
  const { url, expiresAt } = await presignGet({
    key: options.key,
    expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
    profile: 'public',
    responseContentType: inline ? type : (options.attachmentType ?? 'application/octet-stream'),
    responseContentDisposition: contentDisposition(inline ? 'inline' : 'attachment', options.name),
  })
  return { url, expiresAt, inline }
}

// ── object operations ───────────────────────────────────────────────────────

export function isS3NotFound(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false
  return error.$metadata.httpStatusCode === 404 || error.name === 'NotFound' || error.name === 'NoSuchKey'
}

/** S3 answers 416 InvalidRange to a range that starts at or after the end of the object. */
export function isS3InvalidRange(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false
  return error.$metadata.httpStatusCode === 416 || error.name === 'InvalidRange'
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await useS3().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: key }))
    return true
  } catch (error) {
    if (isS3NotFound(error)) return false
    throw error
  }
}

export async function putObject(key: string, body: Buffer | string, contentType: string, metadata?: Record<string, string>): Promise<void> {
  await useS3().send(new PutObjectCommand({ Bucket: s3Bucket(), Key: key, Body: body, ContentType: contentType, Metadata: metadata }))
}

/** Streams a body of unknown length into an object (multipart when large). */
export async function uploadStream(key: string, body: Readable, contentType: string, metadata?: Record<string, string>): Promise<void> {
  await new Upload({
    client: useS3(),
    params: { Bucket: s3Bucket(), Key: key, Body: body, ContentType: contentType, Metadata: metadata },
    queueSize: 2,
    partSize: 8 * 1024 * 1024,
  }).done()
}

export interface ObjectHead {
  size: number
  contentType: string | null
  metadata: Record<string, string>
}

/** Size, type and metadata of an object, or null when it does not exist. */
export async function headObject(key: string): Promise<ObjectHead | null> {
  try {
    const head = await useS3().send(new HeadObjectCommand({ Bucket: s3Bucket(), Key: key }))
    return { size: head.ContentLength ?? 0, contentType: head.ContentType ?? null, metadata: head.Metadata ?? {} }
  } catch (error) {
    if (isS3NotFound(error)) return null
    throw error
  }
}

// ── multipart uploads (script-run outputs) ──────────────────────────────────

/** The S3 error code (`NoSuchUpload`, `InvalidPart`, `EntityTooSmall`, …) of a failed S3 call, else null. */
export function s3ErrorCode(error: unknown): string | null {
  return error instanceof S3ServiceException ? error.name : null
}

/** Starts a multipart upload of `key` and returns its upload id. Metadata values must be ASCII. */
export async function createMultipartUpload(key: string, contentType: string, metadata?: Record<string, string>): Promise<string> {
  const response = await useS3().send(new CreateMultipartUploadCommand({ Bucket: s3Bucket(), Key: key, ContentType: contentType, Metadata: metadata }))
  if (!response.UploadId) throw new Error(`S3 returned no upload id for ${key}`)
  return response.UploadId
}

export interface PresignUploadPartOptions {
  key: string
  uploadId: string
  /** 1–10000 */
  partNumber: number
  contentLength: number
  expiresInSeconds: number
  profile: EndpointProfile
}

/**
 * A presigned UploadPart PUT whose `Content-Length` is a signed header: the uploader must send exactly the returned
 * headers, so a part can never be larger than the size it was presigned (and reserved) for.
 */
export async function presignUploadPart(options: PresignUploadPartOptions): Promise<PresignedPut> {
  const command = new UploadPartCommand({
    Bucket: s3Bucket(),
    Key: options.key,
    UploadId: options.uploadId,
    PartNumber: options.partNumber,
    ContentLength: options.contentLength,
  })
  const url = await getSignedUrl(clientFor(s3EndpointFor(options.profile)), command, {
    expiresIn: options.expiresInSeconds,
    signableHeaders: new Set(['content-length']),
  })
  return {
    url,
    headers: { 'Content-Length': String(options.contentLength) },
    expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
  }
}

export interface CompletedPart {
  partNumber: number
  /** the ETag header the part upload answered with */
  etag: string
}

/** Completes a multipart upload from its parts (sorted by part number here). */
export async function completeMultipartUpload(key: string, uploadId: string, parts: readonly CompletedPart[]): Promise<void> {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber)
  await useS3().send(
    new CompleteMultipartUploadCommand({
      Bucket: s3Bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: sorted.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
    }),
  )
}

/** Aborts a multipart upload and frees its parts; an upload that no longer exists counts as aborted. */
export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  try {
    await useS3().send(new AbortMultipartUploadCommand({ Bucket: s3Bucket(), Key: key, UploadId: uploadId }))
  } catch (error) {
    if (s3ErrorCode(error) === 'NoSuchUpload' || isS3NotFound(error)) return
    throw error
  }
}

export async function getObjectStream(key: string): Promise<Readable> {
  const response = await useS3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key }))
  return response.Body as Readable
}

/**
 * The bytes `start`…`endInclusive` of an object (an HTTP `Range` GET). At most `endInclusive - start + 1` bytes are
 * read, also from a server that sends more; fewer come back when the object is shorter. A response that ignored the
 * range of a non-zero start would return the wrong bytes, so it is an error. Callers pass the key of a stored FileRef,
 * never one built from input.
 */
export async function getObjectRange(key: string, start: number, endInclusive: number): Promise<Buffer> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start) {
    throw new Error(`invalid byte range ${start}-${endInclusive}`)
  }
  const response = await useS3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key, Range: `bytes=${start}-${endInclusive}` }))
  const body = response.Body as Readable
  const served = /^bytes (\d+)-/.exec(response.ContentRange ?? '')
  if ((served ? Number(served[1]) : 0) !== start) {
    body.destroy()
    throw new Error(`S3 answered range ${response.ContentRange ?? '(none)'} for bytes ${start}-${endInclusive} of ${key}`)
  }
  return readAtMost(body, endInclusive - start + 1)
}

/** Reads up to `limit` bytes of a stream and destroys it once they arrived. */
async function readAtMost(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      const room = limit - length
      chunks.push(bytes.length > room ? bytes.subarray(0, room) : bytes)
      length += Math.min(bytes.length, room)
      if (length >= limit) break
    }
  } finally {
    stream.destroy()
  }
  return Buffer.concat(chunks, length)
}

export async function copyObject(sourceKey: string, targetKey: string): Promise<void> {
  await useS3().send(
    new CopyObjectCommand({ Bucket: s3Bucket(), Key: targetKey, CopySource: `${s3Bucket()}/${encodeURIComponent(sourceKey).replaceAll('%2F', '/')}` }),
  )
}

export async function deleteObject(key: string): Promise<void> {
  await useS3().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key }))
}

/** Deletes every object under `prefix` (in batches of 1000) and returns the number deleted. */
export async function deletePrefix(prefix: string): Promise<number> {
  if (!prefix.endsWith('/')) throw new Error(`refusing to delete prefix without trailing slash: ${prefix}`)
  const s3 = useS3()
  let deleted = 0
  let token: string | undefined
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: s3Bucket(), Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }))
    const objects = (page.Contents ?? []).flatMap((object) => (object.Key ? [{ Key: object.Key }] : []))
    if (objects.length > 0) {
      const result = await s3.send(new DeleteObjectsCommand({ Bucket: s3Bucket(), Delete: { Objects: objects, Quiet: true } }))
      if (result.Errors && result.Errors.length > 0) {
        throw new Error(`deleting ${prefix}: ${result.Errors.length} objects failed (${result.Errors[0]?.Message ?? 'unknown error'})`)
      }
      deleted += objects.length
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (token)
  return deleted
}

// ── bucket configuration (boot step 4) ──────────────────────────────────────

export function lifecycleRules(config: Pick<Config, 'testRunRetentionDays' | 'exportRetentionDays'>) {
  return [
    { ID: 'test-runs', Status: 'Enabled' as const, Filter: { Prefix: 'test-runs/' }, Expiration: { Days: config.testRunRetentionDays } },
    { ID: 'exports', Status: 'Enabled' as const, Filter: { Prefix: 'exports/' }, Expiration: { Days: config.exportRetentionDays } },
    { ID: 'tmp', Status: 'Enabled' as const, Filter: { Prefix: 'tmp/' }, Expiration: { Days: 1 } },
    {
      ID: 'abort-incomplete-multipart',
      Status: 'Enabled' as const,
      Filter: { Prefix: '' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    },
  ]
}

/**
 * Ensures the private bucket, its CORS (GET/HEAD from the dashboard origin only) and its lifecycle rules for
 * `test-runs/`, `exports/`, `tmp/` and incomplete multipart uploads (docs/data-model.md §9).
 */
export async function ensureBucket(log: Logger = useLogger('s3')): Promise<void> {
  const config = useConfig()
  const s3 = useS3()
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3Bucket }))
  } catch (error) {
    if (!isS3NotFound(error)) throw error
    await s3.send(new CreateBucketCommand({ Bucket: config.s3Bucket }))
    log.info('created bucket', { bucket: config.s3Bucket })
  }
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: config.s3Bucket,
      CORSConfiguration: {
        CORSRules: [{ AllowedOrigins: [config.publicUrl], AllowedMethods: ['GET', 'HEAD'], AllowedHeaders: ['*'], MaxAgeSeconds: 3600 }],
      },
    }),
  )
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: config.s3Bucket,
      LifecycleConfiguration: { Rules: lifecycleRules(config) },
    }),
  )
}

/** True when the bucket answers HeadBucket within a short timeout. */
export async function s3Reachable(): Promise<boolean> {
  try {
    await useS3().send(new HeadBucketCommand({ Bucket: s3Bucket() }), { abortSignal: AbortSignal.timeout(3000) })
    return true
  } catch {
    return false
  }
}
