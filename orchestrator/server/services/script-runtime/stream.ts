import { Readable } from 'node:stream'
import { type H3Event, sendStream, setResponseHeader } from 'h3'
import { type Collection, type Document, MongoServerError } from 'mongodb'
import type { AnalysisDoc, FileRefDoc, ScanDoc } from '../../types/documents'
import { shutdownSignal } from '../../utils/boot'
import type { Config } from '../../utils/config'
import { ApiError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { ScriptRunPrincipal } from '../../utils/principal'
import { presignInternalGet } from '../../utils/s3'
import { getCachedUser, isUserBanned } from '../../utils/user-cache'
import { normalizeFieldPaths, pickPaths } from '../analyses/fields'
import { analysisMaskPatterns } from '../analyses/masking'
import { toApiAnalysis, toApiDocument } from '../analyses/representation'
import { type ExportSelection, exportDocuments } from '../exports/rows'
import { validateExportSelection } from '../exports/service'
import { mapQueryError } from '../query/errors'
import { type QueryLimits, queryAnalysesCollection } from '../query/execute'
import { acquireRunReadSlot } from './limiter'
import { FILE_URL_TTL_SECONDS, STREAM_KEEPALIVE_MS } from './limits'
import type { StreamAnalysesBody } from './schemas'

/*
 * scriptRuntimeStreamAnalyses (docs/scripts.md, docs/api.md): the analyses of one scan of the run as NDJSON in seq
 * order, read in the export's seq windows (services/exports/rows.ts) from the `scantor_query` client, masked like every
 * other read and with presigned internal GETs of the stored files beside each analysis. Lines:
 *
 *   {"analysis": {...}, "urls": {"<fileId>": "<url>"}}   one per analysis (`urls` only for stored files)
 *   {"checkpoint": {"afterSeq": N}}                       after every seq window and after STREAM_KEEPALIVE_MS of
 *                                                         silence: every match with seq ≤ N was sent (resume point)
 *   {"end": {"afterSeq": N, "count": n, "limited": b}}    exactly once on success; `limited`: settings.limit cut it
 *   {"error": {"code", "message", "retryable"}}           instead of `end` on a failure, then the stream closes
 *
 * Before every further window the run must still be `running`, the scan its owner's and not being deleted, and the
 * owner not banned; otherwise the stream ends with a non-retryable error line. A shutdown, a transient database error
 * or a lost cursor end it with a retryable one: the client resumes after max(its last seq, the last checkpoint).
 */

const log = useLogger('script-runtime')

/** The analysis fields a stream sends when the request names none. */
export const DEFAULT_STREAM_FIELDS = ['id', 'seq', 'status', 'attempt', 'round', 'config', 'result', 'error', 'files'] as const

/** MongoDB's CursorNotFound: the server dropped the window's cursor (idle timeout, failover). */
const CURSOR_NOT_FOUND = 43

export interface StreamLineError {
  code: string
  message: string
  retryable: boolean
}

/** A reason to end a stream that the per-window re-check found (never retryable). */
export class StreamStop extends Error {
  constructor(
    readonly code: 'unauthorized' | 'notFound',
    message: string,
  ) {
    super(message)
    this.name = 'StreamStop'
  }
}

/** The error line of a failure while streaming. */
export function streamErrorOf(error: unknown): StreamLineError {
  if (error instanceof StreamStop) return { code: error.code, message: error.message, retryable: false }
  const mapped = mapQueryError(error, 'filter')
  if (mapped instanceof ApiError) {
    const cursorLost = mapped.details?.mongoCode === CURSOR_NOT_FOUND
    return {
      code: cursorLost ? 'unavailable' : mapped.code,
      message: cursorLost ? 'the database dropped the cursor; resume after the last seq' : mapped.message,
      retryable: cursorLost || mapped.code === 'unavailable',
    }
  }
  if (error instanceof MongoServerError && error.code === CURSOR_NOT_FOUND) {
    return { code: 'unavailable', message: 'the database dropped the cursor; resume after the last seq', retryable: true }
  }
  log.error('streaming analyses to a script run failed', { err: error })
  return { code: 'internal', message: 'unexpected server error while streaming analyses', retryable: false }
}

export interface StreamPlan {
  selection: ExportSelection
  /** representation paths of each analysis line, or null for the full representation (`fields: 'all'`) */
  fields: string[] | null
  fileUrls: boolean
  /** analysis lines after which the stream ends with `limited: true` (settings.limit), or null */
  limit: number | null
}

/**
 * The selection of a stream request (400 for filters and fields the export rules reject). `id` and `seq` are always
 * sent (the client resumes after the last seq); with file URLs `files` is too, because a FileRef in a result resolves
 * by id against the analysis's `files`.
 */
export function planStream(scan: ScanDoc, body: StreamAnalysesBody, limit: number | null): StreamPlan {
  const filter = body.filter ?? {}
  const requested = body.fields === 'all' ? undefined : (body.fields ?? [...DEFAULT_STREAM_FIELDS])
  let fields = validateExportSelection(scan, filter, requested)
  if (fields) fields = normalizeFieldPaths(['id', 'seq', ...fields, ...(body.fileUrls ? ['files'] : [])])
  return {
    selection: { scan, filter, status: body.status, afterSeq: body.afterSeq ?? null, untilSeq: body.untilSeq ?? null, fields },
    fields,
    fileUrls: body.fileUrls,
    limit,
  }
}

export interface StreamDeps {
  collection: Collection<Document>
  limits: QueryLimits
  /** aborted at shutdown (and when the client went away): the stream ends with a retryable error line */
  signal: AbortSignal
  /** the per-window re-check; throws StreamStop to end the stream */
  recheck: () => Promise<void>
  /** a presigned internal GET of a stored file */
  sign: (key: string) => string
  keepAliveMs: number
  /** runs between two windows so a stream never holds the event loop (setImmediate) */
  pause: () => Promise<void>
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`

function fileUrls(files: unknown, sign: (key: string) => string): Record<string, string> | null {
  if (!Array.isArray(files)) return null
  let urls: Record<string, string> | null = null
  for (const file of files as Partial<FileRefDoc>[]) {
    if (typeof file?.id !== 'string' || typeof file.key !== 'string' || file.key === '') continue
    urls ??= {}
    urls[file.id] = sign(file.key)
  }
  return urls
}

type Raced<T> = { kind: 'value'; result: IteratorResult<T> } | { kind: 'idle' } | { kind: 'aborted' }

/**
 * Waits for `next`, at most `ms`; an abort of `signal` wins at once. The abort listener and the timer live only for
 * this call: racing every line against one stream-wide promise would keep a reaction per line until the stream ends.
 */
async function raceNext<T>(next: Promise<IteratorResult<T>>, signal: AbortSignal, ms: number): Promise<Raced<T>> {
  if (signal.aborted) return { kind: 'aborted' }
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      next.then((result): Raced<T> => ({ kind: 'value', result })),
      new Promise<Raced<T>>((resolve) => {
        onAbort = () => resolve({ kind: 'aborted' })
        signal.addEventListener('abort', onAbort, { once: true })
        timer = setTimeout(() => resolve({ kind: 'idle' }), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** The NDJSON lines of one stream (see the header). Never throws: failures become the final error line. */
export async function* analysisStreamLines(plan: StreamPlan, deps: StreamDeps): AsyncGenerator<string> {
  const patterns = analysisMaskPatterns(plan.selection.scan.secretPaths)
  let resumeAfter = plan.selection.afterSeq ?? -1
  let windowEnd: number | null = null
  let count = 0
  const documents = exportDocuments(plan.selection, 'jsonl', deps.collection, deps.limits, async ({ afterSeq }) => {
    windowEnd = afterSeq
    await deps.pause()
    await deps.recheck()
  })
  const iterator = documents[Symbol.asyncIterator]()
  const reachedWindow = (): string | null => {
    if (windowEnd === null) return null
    resumeAfter = Math.max(resumeAfter, windowEnd)
    windowEnd = null
    return line({ checkpoint: { afterSeq: resumeAfter } })
  }
  try {
    for (;;) {
      const next = iterator.next()
      let result: IteratorResult<Document> | null = null
      while (result === null) {
        const raced = await raceNext(next, deps.signal, deps.keepAliveMs)
        if (raced.kind === 'idle') yield reachedWindow() ?? line({ checkpoint: { afterSeq: resumeAfter } })
        else if (raced.kind === 'aborted') {
          next.catch(() => undefined)
          yield reachedWindow() ?? line({ checkpoint: { afterSeq: resumeAfter } })
          yield line({ error: { code: 'unavailable', message: 'the orchestrator is stopping; resume after the last seq', retryable: true } })
          return
        } else result = raced.result
      }
      const checkpoint = reachedWindow()
      if (checkpoint) yield checkpoint
      if (result.done) break
      const doc = result.value
      const analysis = plan.fields ? pickPaths(toApiDocument(doc, patterns), plan.fields) : toApiAnalysis(doc as AnalysisDoc, patterns)
      const urls = plan.fileUrls ? fileUrls(doc.files, deps.sign) : null
      yield line(urls ? { analysis, urls } : { analysis })
      count += 1
      if (typeof doc.seq === 'number') resumeAfter = Math.max(resumeAfter, doc.seq)
      if (plan.limit !== null && count >= plan.limit) {
        yield line({ end: { afterSeq: resumeAfter, count, limited: true } })
        return
      }
    }
    yield line({ end: { afterSeq: resumeAfter, count, limited: false } })
  } catch (error) {
    const checkpoint = reachedWindow()
    if (checkpoint) yield checkpoint
    yield line({ error: streamErrorOf(error) })
  } finally {
    // Closes the window's cursor; a pending read finishes first (bounded by maxTimeMS).
    void iterator.return?.(undefined)?.catch(() => undefined)
  }
}

/** The per-window re-check of a stream: run running, scan owned and live, owner not banned. */
export async function recheckStream(principal: ScriptRunPrincipal, scanId: string): Promise<void> {
  const { id, userId } = principal.scriptRun
  let run: { state: string } | null
  let scan: { state: string } | null
  try {
    ;[run, scan] = await Promise.all([
      useCollections().scriptRuns.findOne({ _id: id, userId }, { projection: { state: 1 } }),
      useCollections().scans.findOne({ _id: scanId, userId }, { projection: { state: 1 } }),
    ])
  } catch (error) {
    throw mapQueryError(error, 'scan')
  }
  if (run?.state !== 'running') throw new StreamStop('unauthorized', 'the script run is no longer running')
  if (!scan || scan.state === 'deleting' || scan.state === 'deleted') throw new StreamStop('notFound', 'the scan no longer exists')
  const owner = await getCachedUser(userId)
  if (!owner || isUserBanned(owner)) throw new StreamStop('unauthorized', 'the owner of the script run is not allowed to sign in')
}

/** Grace for a stream whose client does not read the final line after the shutdown began. */
const SHUTDOWN_DESTROY_MS = 5000
const STREAM_HIGH_WATER_MARK = 256 * 1024

/**
 * Sends the stream of `plan` as the response. Holds one of the run's read slots until the stream closes; ends on
 * shutdownSignal() (destroyed after SHUTDOWN_DESTROY_MS when the client does not take the last lines).
 */
export async function sendAnalysisStream(
  event: H3Event,
  principal: ScriptRunPrincipal,
  scan: ScanDoc,
  plan: StreamPlan,
  config: Pick<Config, 'queryMaxTimeMs' | 'queryMaxDocs'>,
): Promise<void> {
  const release = acquireRunReadSlot(principal.scriptRun.id)
  const clientGone = new AbortController()
  const stopping = shutdownSignal()
  let stream: Readable
  let destroyTimer: NodeJS.Timeout | undefined
  const onShutdown = () => {
    destroyTimer = setTimeout(() => {
      if (!stream.destroyed) stream.destroy()
    }, SHUTDOWN_DESTROY_MS)
    destroyTimer.unref()
  }
  try {
    const collection = await queryAnalysesCollection()
    const lines = analysisStreamLines(plan, {
      collection,
      limits: { queryMaxTimeMs: config.queryMaxTimeMs, queryMaxDocs: config.queryMaxDocs },
      signal: AbortSignal.any([stopping, clientGone.signal]),
      recheck: () => recheckStream(principal, scan._id),
      sign: (key) => presignInternalGet(key, FILE_URL_TTL_SECONDS).url,
      keepAliveMs: STREAM_KEEPALIVE_MS,
      pause: () => new Promise((resolve) => setImmediate(resolve)),
    })
    stream = Readable.from(lines, { objectMode: false, highWaterMark: STREAM_HIGH_WATER_MARK })
    // 'close' follows the end of the stream as well as a destroy (client gone, error), even before the first read.
    stream.once('close', () => {
      release()
      clearTimeout(destroyTimer)
      stopping.removeEventListener('abort', onShutdown)
    })
  } catch (error) {
    release()
    throw error
  }
  if (stopping.aborted) onShutdown()
  else stopping.addEventListener('abort', onShutdown, { once: true })
  setResponseHeader(event, 'Content-Type', 'application/x-ndjson')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  event.node.res.once('close', () => {
    clientGone.abort()
    if (!stream.destroyed) stream.destroy()
  })
  try {
    await sendStream(event, stream)
  } catch (error) {
    log.warn('an analysis stream of a script run broke off', { scriptRunId: principal.scriptRun.id, scanId: scan._id, err: error })
    event.node.res.destroy()
  }
}
