import type { EndpointProfile } from '#shared/utils/enums'
import type { ScanDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError, validationError } from '../../utils/errors'
import { useCollections } from '../../utils/mongo'
import type { WorkerPrincipal } from '../../utils/principal'
import { presignPut, safeName } from '../../utils/s3'
import { isoDate } from '../../utils/serialize'

// POST /api/runtime/uploads/presign (docs/api.md §8.3, docs/architecture.md §11.5, security.md ING-5, RES-5): the
// scan comes from the worker token, never from the body; the server validates the runtime-generated file ids,
// checks the limits and the owner's storage quota, generates every key itself and presigns PUTs for the node's S3
// endpoint with Content-Type, Content-Length and the object metadata (docs/data-model.md §9) signed as headers. The
// runtime must send exactly the returned headers.

export interface PresignFileInput {
  fileId: string
  name: string
  size: number
  sha256: string
  contentType: string
}

export interface PresignInput {
  seq: number
  round: number
  attempt: number
  executionId: string
  files: PresignFileInput[]
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * The S3 key of an analysis file (docs/data-model.md §9). The ingestor recomputes keys with this function, so the
 * keys stored on analyses always match the presigned uploads.
 */
export function analysisFileKey(scanId: string, seq: number, executionId: string, fileId: string, name: string): string {
  return `files/${scanId}/${seq}/${executionId}/${fileId}/${safeName(name)}`
}

export type PresignLimits = Pick<Config, 'maxFileBytes' | 'maxFilesPerAnalysis' | 'maxAnalysesPerScan'>

/** Validation of a presign request against the scan and the limits (docs/api.md §8.3 errors). */
export function presignProblems(input: PresignInput, scan: Pick<ScanDoc, 'round'>, limits: PresignLimits): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = []
  if (input.seq >= limits.maxAnalysesPerScan) issues.push({ path: 'seq', message: `seq must be below ${limits.maxAnalysesPerScan}` })
  if (input.round > scan.round) issues.push({ path: 'round', message: `round ${input.round} is newer than the scan's round ${scan.round}` })
  if (input.files.length > limits.maxFilesPerAnalysis) {
    issues.push({ path: 'files', message: `at most ${limits.maxFilesPerAnalysis} files per analysis` })
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  input.files.forEach((file, index) => {
    if (!UUID_V4.test(file.fileId)) issues.push({ path: `files.${index}.fileId`, message: 'must be a uuid v4' })
    else if (ids.has(file.fileId)) issues.push({ path: `files.${index}.fileId`, message: 'duplicate fileId' })
    ids.add(file.fileId)
    if (names.has(file.name)) issues.push({ path: `files.${index}.name`, message: 'duplicate file name' })
    names.add(file.name)
    if (file.size > limits.maxFileBytes) issues.push({ path: `files.${index}.size`, message: `files may be at most ${limits.maxFileBytes} bytes` })
  })
  return issues
}

// ── storage quota ───────────────────────────────────────────────────────────

/** How long a measured usage is reused before it is aggregated again. */
export const USAGE_CACHE_MS = 60_000

interface UsageEntry {
  /** bytes measured from the analyses of the user's scans */
  measured: number
  /** bytes presigned in this process since the measurement */
  presigned: number
  at: number
}

const usage = new Map<string, UsageEntry>()

/** Bytes of analysis files of a user's scans (files of succeeded analyses; deleted scans have none). */
async function measureUsage(userId: string): Promise<number> {
  const { scans, analyses } = useCollections()
  const scanIds = (await scans.find({ userId, state: { $nin: ['deleting', 'deleted'] } }, { projection: { _id: 1 } }).toArray()).map((scan) => scan._id)
  if (scanIds.length === 0) return 0
  const [result] = await analyses
    .aggregate<{ bytes: number }>([
      { $match: { scanId: { $in: scanIds }, status: 'succeeded', 'files.0': { $exists: true } } },
      { $project: { bytes: { $sum: '$files.size' } } },
      { $group: { _id: null, bytes: { $sum: '$bytes' } } },
    ])
    .toArray()
  return result?.bytes ?? 0
}

/** Reserves `bytes` of the user's quota; throws 403 quotaExceeded when it would be exceeded. 0 = unlimited. */
export async function reserveStorage(userId: string, bytes: number, quotaBytes: number, now = Date.now()): Promise<void> {
  if (quotaBytes <= 0) return
  let entry = usage.get(userId)
  if (!entry || now - entry.at > USAGE_CACHE_MS) {
    entry = { measured: await measureUsage(userId), presigned: 0, at: now }
    usage.set(userId, entry)
  }
  if (entry.measured + entry.presigned + bytes > quotaBytes) {
    throw apiError('quotaExceeded', 'the storage quota of the scan owner is exhausted', { limit: quotaBytes, used: entry.measured + entry.presigned })
  }
  entry.presigned += bytes
}

export function resetStorageUsageCache(): void {
  usage.clear()
}

// ── presigning ──────────────────────────────────────────────────────────────

/** The object metadata of an analysis file (docs/data-model.md §9); header values must be ASCII. */
export function analysisFileMetadata(fileId: string, name: string): Record<string, string> {
  return { 'file-id': fileId, name: encodeURIComponent(name) }
}

// ── handler ─────────────────────────────────────────────────────────────────

export type PresignConfig = PresignLimits & Pick<Config, 'userStorageQuotaBytes' | 'uploadTimeoutMs'>

export async function handlePresign(principal: WorkerPrincipal, input: PresignInput, config: PresignConfig) {
  const { scans, nodes } = useCollections()
  const { worker } = principal
  const scan = await scans.findOne({ _id: worker.scanId }, { projection: { _id: 1, userId: 1, round: 1, state: 1 } })
  if (!scan || scan.state === 'deleting' || scan.state === 'deleted') throw apiError('notFound', 'the scan of this worker no longer exists')
  const issues = presignProblems(input, scan, config)
  if (issues.length > 0) throw validationError(issues)
  if (input.files.length === 0) return { files: [] }

  await reserveStorage(scan.userId, input.files.reduce((sum, file) => sum + file.size, 0), config.userStorageQuotaBytes)
  const node = await nodes.findOne({ _id: worker.nodeId }, { projection: { endpointProfile: 1 } })
  const profile: EndpointProfile = node?.endpointProfile ?? 'public'
  const expiresInSeconds = Math.max(1, Math.round(config.uploadTimeoutMs / 1000))
  const files = await Promise.all(
    input.files.map(async (file) => {
      const signed = await presignPut({
        key: analysisFileKey(scan._id, input.seq, input.executionId, file.fileId, file.name),
        contentType: file.contentType,
        contentLength: file.size,
        metadata: analysisFileMetadata(file.fileId, file.name),
        expiresInSeconds,
        profile,
      })
      return { fileId: file.fileId, name: file.name, url: signed.url, method: 'PUT' as const, headers: signed.headers, expiresAt: isoDate(signed.expiresAt) }
    }),
  )
  return { files }
}
