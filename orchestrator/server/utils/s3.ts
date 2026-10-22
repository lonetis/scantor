import type { Readable } from 'node:stream'
import {
  CopyObjectCommand,
  CreateBucketCommand,
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

const clients = new Map<string, S3Client>()

function createS3Client(endpoint: string, config: Config): S3Client {
  return new S3Client({
    endpoint,
    region: 'us-east-1',
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

export async function getObjectStream(key: string): Promise<Readable> {
  const response = await useS3().send(new GetObjectCommand({ Bucket: s3Bucket(), Key: key }))
  return response.Body as Readable
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
