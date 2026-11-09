import type { ScriptRunLogLine, ScriptRunLogsPage } from '#shared/types/scripts'
import type { ScriptRunLogStream } from '#shared/utils/enums'
import type { ScriptRunDoc, ScriptRunLogChunkDoc, ScriptRunLogLineDoc, ScriptRunLogStateDoc } from '../../types/documents'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { isoDate } from '../../utils/serialize'
import { maskableSecrets, maskScriptRunText } from '../script-runtime/secrets'
import { isScriptRunSettled } from './mappers'

// The log of a script run (docs/scripts.md, docs/data-model.md `scriptRunLogs`): build events, the container's stdout
// and stderr and platform lines, numbered from 1 and stored in chunks `<runId>-<chunk>` of at most 500 lines. Bounds:
//   - lines over 16 KiB are cut with a marker; every stored line passes the redaction rules (tokens, signatures) and
//     the run's own secret values are masked
//   - ingestion: at most 1 MiB/s and 2000 lines/s averaged over 10 s windows; excess lines are counted in
//     `droppedLines` and replaced by one `system` marker per window
//   - while the writes fail, at most one rate window of lines waits (further lines are dropped, counted, one marker)
//     and the 2 s timer alone retries (one warning per failure streak); otherwise the rate limit bounds what waits
//   - retention: the head chunks (the first 1 MiB) and the tail up to SCANTOR_SCRIPT_RUN_MAX_LOG_BYTES are kept; the
//     oldest chunks between them are deleted (counted in `droppedLines`). One marker line is appended the first time;
//     the chunk that holds it carries `retentionMarker`, and when a later pass deletes that chunk, the marker is
//     appended again, so exactly one stays visible
// The newest chunk stays open: every flush rewrites it whole (replaceOne upsert, idempotent) with the lines that
// arrived, until it holds 500 lines; then the next chunk opens. Every chunk but the newest therefore holds exactly 500
// lines, so line N lies in chunk floor((N - 1) / 500) or later and reads seek by chunk number. The run's `log` state
// follows in the same flush; a writer that resumes recomputes its position from the stored chunks and reopens the
// newest one, so a crash between the two writes loses nothing. The follower's resume position (`cursor`) is the
// Docker timestamp of the last container line actually stored (lines appended during a write are not covered).
// A writer whose run document is gone stops and deletes the chunks it wrote.

export const LOG_LINE_MAX_BYTES = 16 * 1024
export const LOG_CHUNK_MAX_LINES = 500
export const LOG_FLUSH_INTERVAL_MS = 2000
export const LOG_HEAD_BYTES = 1024 * 1024
export const LOG_RATE_WINDOW_MS = 10_000
export const LOG_RATE_MAX_BYTES = 10 * 1024 * 1024
export const LOG_RATE_MAX_LINES = 20_000
/** While writes fail, at most one rate window of lines waits for the next write; further lines are dropped (counted). */
export const LOG_PENDING_MAX_LINES = LOG_RATE_MAX_LINES
export const LOG_PENDING_MAX_BYTES = LOG_RATE_MAX_BYTES
export const LOG_TAIL_MAX_LINES = 50
export const LOG_TAIL_MAX_BYTES = 16 * 1024
const TRUNCATED_MARKER = ' [line truncated]'

export function emptyLogState(): ScriptRunLogStateDoc {
  return { lines: 0, bytes: 0, firstLine: 1, droppedLines: 0, nextChunk: 0, cursor: null }
}

export function chunkId(scriptRunId: string, chunk: number): string {
  return `${scriptRunId}-${chunk}`
}

/** Cuts text to at most maxBytes UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  // A character split at the cut decodes to U+FFFD; drop it.
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1)
  return { text: cut, truncated: true }
}

/** Nanoseconds since the epoch of a Docker RFC3339Nano timestamp (trailing zeros of the fraction are trimmed). */
export function timestampNanos(ts: string): bigint | null {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(ts)
  if (!match) return null
  const seconds = Date.parse(`${match[1]}${match[3]}`)
  if (Number.isNaN(seconds)) return null
  return BigInt(seconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'))
}

/** Docker's `since` for a resume at cursor `ts`: one second earlier, as `<sec>.<nanos>`. */
export function sinceOf(ts: string): string | undefined {
  const nanos = timestampNanos(ts)
  if (nanos === null) return undefined
  const since = nanos - 1_000_000_000n
  const seconds = since / 1_000_000_000n
  const fraction = (since % 1_000_000_000n).toString().padStart(9, '0')
  return `${seconds}.${fraction}`
}

export interface LogWriterOptions {
  maxLogBytes: number
  /** the run's secret values, masked in every line */
  secrets?: readonly string[]
  log: Pick<Logger, 'warn'>
  now?: () => number
}

type LogCursor = ScriptRunLogStateDoc['cursor']

interface StoredLine extends ScriptRunLogLineDoc {
  bytes: number
  /** the retention marker (its chunk is stored with `retentionMarker`) */
  marker?: true
}

interface PendingLine extends StoredLine {
  /** the follower cursor right after this line was appended (stored once the line is) */
  cursor: LogCursor
}

/** A stored chunk as the retention needs it. */
interface ChunkInfo {
  chunk: number
  firstLine: number
  bytes: number
  /** the chunk holds the retention marker */
  marker: boolean
}

function sumBytes(lines: readonly StoredLine[]): number {
  return lines.reduce((sum, line) => sum + line.bytes, 0)
}

/**
 * Appends lines to the stored log of one run; flushes every LOG_FLUSH_INTERVAL_MS or LOG_CHUNK_MAX_LINES lines. A
 * writer that continues a stored log calls resume() before its first line.
 */
export class ScriptRunLogWriter {
  /** the stored position; `cursor` is the cursor of the last stored line */
  private state: ScriptRunLogStateDoc
  /** the cursor of the last line appended (the follower's position within this execution) */
  private liveCursor: LogCursor
  private pending: PendingLine[] = []
  private pendingBytes = 0
  /** the stored lines of the open chunk `state.nextChunk`, rewritten whole with the next lines */
  private open: StoredLine[] = []
  /** the stored chunks, oldest first */
  private chunks: ChunkInfo[] = []
  private chain: Promise<void> = Promise.resolve()
  /** a flush queued behind the running write; later flush calls join it */
  private queued: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private windowStart = 0
  private windowBytes = 0
  private windowLines = 0
  private windowDropped = 0
  /** a retention marker is pending or stored in a chunk that still exists */
  private retentionMarked = false
  /** the last write failed: only the timer retries, and lines beyond the pending bound are dropped */
  private failing = false
  private overflowMarked = false
  /** the run document is gone: nothing is written any more */
  private gone = false
  private readonly secrets: string[]
  private readonly now: () => number

  constructor(
    private readonly scriptRunId: string,
    state: ScriptRunLogStateDoc | undefined,
    private readonly options: LogWriterOptions,
  ) {
    this.state = { ...emptyLogState(), ...state }
    this.liveCursor = this.state.cursor
    this.secrets = maskableSecrets(options.secrets ?? [])
    this.now = options.now ?? Date.now
  }

  /** The resume position of the container log follower. */
  get cursor(): LogCursor {
    return this.liveCursor
  }

  get lines(): number {
    return this.state.lines + this.pending.length
  }

  /**
   * Recomputes the position from the stored chunks: a chunk written before a crash whose `log` state update did not
   * follow is counted (its lines are not written again), and the newest chunk is reopened while it has room.
   */
  async resume(): Promise<void> {
    const { scriptRunLogs } = useCollections()
    const stored = (await scriptRunLogs
      .find({ scriptRunId: this.scriptRunId }, { projection: { _id: 0, chunk: 1, firstLine: 1, bytes: 1, retentionMarker: 1 } })
      .sort({ chunk: 1 })
      .toArray()) as unknown as Pick<ScriptRunLogChunkDoc, 'chunk' | 'firstLine' | 'bytes' | 'retentionMarker'>[]
    this.chunks = stored.map(({ chunk, firstLine, bytes, retentionMarker }) => ({ chunk, firstLine, bytes, marker: retentionMarker === true }))
    this.open = []
    this.retentionMarked = this.chunks.some((info) => info.marker)
    // A crash between deleting chunks and storing their marker leaves a gap without one.
    const gap = this.chunks.some((info, index) => index > 0 && info.chunk !== this.chunks[index - 1]!.chunk + 1)
    if (gap && !this.retentionMarked) this.enqueueRetentionMarker(new Date(this.now()))
    const last = this.chunks.at(-1)
    if (!last) return
    this.state.bytes = this.chunks.reduce((sum, info) => sum + info.bytes, 0)
    if (last.chunk < this.state.nextChunk) return
    const newest = await scriptRunLogs.findOne({ _id: chunkId(this.scriptRunId, last.chunk) })
    const lines = newest?.lines ?? []
    this.state.lines = last.firstLine + lines.length - 1
    if (lines.length >= LOG_CHUNK_MAX_LINES) {
      this.state.nextChunk = last.chunk + 1
      return
    }
    this.state.nextChunk = last.chunk
    const markerText = this.retentionMarkerText()
    this.open = lines.map((line) => ({
      at: line.at,
      stream: line.stream,
      text: line.text,
      bytes: Buffer.byteLength(line.text, 'utf8'),
      ...(last.marker && line.stream === 'system' && line.text === markerText ? { marker: true as const } : {}),
    }))
  }

  start(): void {
    if (this.gone) return
    this.timer ??= setInterval(() => void this.flush(), LOG_FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Stops the timer and writes the pending lines. */
  async close(): Promise<void> {
    this.stopTimer()
    await this.flush()
  }

  /**
   * Appends one line. `ts` is the Docker timestamp of a container line: it advances the follower's cursor. Lines over
   * the ingestion rate are dropped (counted) with one marker per window.
   */
  append(stream: ScriptRunLogStream, text: string, at: Date = new Date(this.now()), ts?: string): void {
    if (this.gone) return
    if (ts) this.advanceCursor(ts)
    if (stream !== 'system' && !this.admit(Buffer.byteLength(text, 'utf8'))) return
    this.push(stream, text, at)
  }

  private push(stream: ScriptRunLogStream, raw: string, at: Date): void {
    if (stream !== 'system' && this.failing && (this.pending.length >= LOG_PENDING_MAX_LINES || this.pendingBytes >= LOG_PENDING_MAX_BYTES)) {
      this.state.droppedLines++
      if (!this.overflowMarked) {
        this.overflowMarked = true
        this.enqueue('system', 'the log store is behind; lines are dropped until it catches up', at)
      }
      return
    }
    let text = maskScriptRunText(raw, this.secrets)
    const cut = truncateUtf8(text, LOG_LINE_MAX_BYTES - TRUNCATED_MARKER.length)
    if (cut.truncated) text = cut.text + TRUNCATED_MARKER
    this.enqueue(stream, text, at)
  }

  private enqueue(stream: ScriptRunLogStream, text: string, at: Date, marker = false): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    this.pending.push({ at, stream, text, bytes, cursor: this.liveCursor, ...(marker ? { marker: true as const } : {}) })
    this.pendingBytes += bytes
    if (this.pending.length >= LOG_CHUNK_MAX_LINES && !this.failing) void this.flush()
  }

  private advanceCursor(ts: string): void {
    const cursor = this.liveCursor
    this.liveCursor = cursor && cursor.ts === ts ? { ts, countAtTs: cursor.countAtTs + 1 } : { ts, countAtTs: 1 }
  }

  /** The ingestion rate limit: true when the line fits into the current window. */
  private admit(bytes: number): boolean {
    const now = this.now()
    if (now - this.windowStart >= LOG_RATE_WINDOW_MS) {
      this.windowStart = now
      this.windowBytes = 0
      this.windowLines = 0
      this.windowDropped = 0
    }
    if (this.windowBytes + bytes <= LOG_RATE_MAX_BYTES && this.windowLines < LOG_RATE_MAX_LINES) {
      this.windowBytes += bytes
      this.windowLines++
      return true
    }
    if (this.windowDropped === 0) {
      this.push('system', 'the log exceeds 1 MiB/s or 2000 lines/s; lines are dropped for the rest of this 10 s window', new Date(now))
    }
    this.windowDropped++
    this.state.droppedLines++
    return false
  }

  /**
   * Writes the lines pending now (into the open chunk, then new chunks) and the run's log state. Serialized; a flush
   * requested while one waits joins it. Never rejects: a failed write keeps its lines pending for the next flush.
   */
  flush(): Promise<void> {
    if (this.queued) return this.queued
    const next = this.chain.then(async () => {
      this.queued = null
      try {
        await this.write()
        this.failing = false
      } catch (error) {
        if (!this.failing) this.options.log.warn('writing the script-run log failed; retrying', { scriptRunId: this.scriptRunId, err: error })
        this.failing = true
      }
    })
    this.queued = next
    this.chain = next
    return next
  }

  private async write(): Promise<void> {
    if (this.gone || this.pending.length === 0) return
    const { scriptRunLogs, scriptRuns } = useCollections()
    // Only the lines pending now: lines arriving meanwhile wait for the next flush instead of rewriting the open
    // chunk once per round trip.
    let remaining = this.pending.length
    while (remaining > 0) {
      const batch = this.pending.slice(0, Math.min(remaining, LOG_CHUNK_MAX_LINES - this.open.length))
      const lines = [...this.open, ...batch]
      const chunk = this.state.nextChunk
      const firstLine = this.state.lines - this.open.length + 1
      const bytes = sumBytes(lines)
      const marker = lines.some((line) => line.marker === true)
      const doc: ScriptRunLogChunkDoc = {
        _id: chunkId(this.scriptRunId, chunk),
        scriptRunId: this.scriptRunId,
        chunk,
        firstLine,
        lines: lines.map(({ at, stream, text }) => ({ at, stream, text })),
        bytes,
        ...(marker ? { retentionMarker: true as const } : {}),
      }
      await scriptRunLogs.replaceOne({ _id: doc._id }, doc, { upsert: true })
      const batchBytes = sumBytes(batch)
      this.pending.splice(0, batch.length)
      this.pendingBytes -= batchBytes
      remaining -= batch.length
      this.state.lines += batch.length
      this.state.bytes += batchBytes
      this.state.cursor = batch.at(-1)!.cursor
      this.noteChunk({ chunk, firstLine, bytes, marker })
      if (lines.length >= LOG_CHUNK_MAX_LINES) {
        this.open = []
        this.state.nextChunk = chunk + 1
      } else {
        this.open = lines.map(({ at, stream, text, bytes: lineBytes, marker: isMarker }) => ({
          at,
          stream,
          text,
          bytes: lineBytes,
          ...(isMarker ? { marker: true as const } : {}),
        }))
      }
    }
    this.overflowMarked = false
    if (this.state.bytes > this.options.maxLogBytes) await this.applyRetention()
    const written = await scriptRuns.updateOne({ _id: this.scriptRunId }, { $set: { log: { ...this.state }, updatedAt: new Date(this.now()) } })
    if (written.matchedCount === 0) await this.discard()
  }

  private noteChunk(info: ChunkInfo): void {
    const last = this.chunks.at(-1)
    if (last?.chunk === info.chunk) {
      last.bytes = info.bytes
      last.marker = info.marker
    } else this.chunks.push(info)
  }

  /** The run document was deleted (a deletion cascade): stop and remove the chunks this writer wrote. */
  private async discard(): Promise<void> {
    this.gone = true
    this.stopTimer()
    this.pending = []
    this.pendingBytes = 0
    this.open = []
    await useCollections().scriptRunLogs.deleteMany({ scriptRunId: this.scriptRunId })
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Deletes the oldest chunks after the head until the stored bytes fit SCANTOR_SCRIPT_RUN_MAX_LOG_BYTES. */
  private async applyRetention(): Promise<void> {
    const chunks = this.chunks
    let head = 0
    let headBytes = 0
    while (head < chunks.length - 1 && headBytes < LOG_HEAD_BYTES) headBytes += chunks[head++]!.bytes
    let stored = this.state.bytes
    let end = head
    let droppedLines = 0
    // The newest chunk always stays; the one after a deleted chunk is its direct successor, so the difference of
    // their first lines is the deleted chunk's line count.
    while (end < chunks.length - 1 && stored > this.options.maxLogBytes) {
      stored -= chunks[end]!.bytes
      droppedLines += chunks[end + 1]!.firstLine - chunks[end]!.firstLine
      end++
    }
    if (end === head) return
    const removed = chunks.slice(head, end)
    await useCollections().scriptRunLogs.deleteMany({ _id: { $in: removed.map((info) => chunkId(this.scriptRunId, info.chunk)) } })
    chunks.splice(head, end - head)
    this.state.bytes = stored
    this.state.droppedLines += droppedLines
    // The marker went with its chunk when a later pass deleted that one: it is appended again.
    if (removed.some((info) => info.marker)) this.retentionMarked = false
    if (!this.retentionMarked) this.enqueueRetentionMarker(new Date(this.now()))
  }

  private retentionMarkerText(): string {
    return `the log exceeds ${this.options.maxLogBytes} bytes: the first 1 MiB and the newest lines are kept, lines in between are dropped`
  }

  private enqueueRetentionMarker(at: Date): void {
    this.retentionMarked = true
    this.enqueue('system', this.retentionMarkerText(), at, true)
  }
}

function toLogLine(line: ScriptRunLogLineDoc, number: number): ScriptRunLogLine {
  return { line: number, at: isoDate(line.at), stream: line.stream, text: line.text }
}

/** The first chunk that can hold line `line` (every chunk before the newest holds exactly 500 lines, never more). */
function firstChunkFor(line: number): number {
  return Math.max(0, Math.floor((line - 1) / LOG_CHUNK_MAX_LINES))
}

/**
 * True when no line follows `nextLine`: the run is terminal, its job no longer runs (a cancelled run's job may still
 * store the lines of the container stop; every job stores its last lines before it ends) and the stored count, read
 * after that check, is reached.
 */
async function logComplete(run: ScriptRunDoc, nextLine: number): Promise<boolean> {
  if (!isScriptRunSettled(run) || nextLine < run.log.lines) return false
  const { jobs, scriptRuns } = useCollections()
  if ((await jobs.countDocuments({ kind: 'scriptRun', 'subject.id': run._id, active: true }, { limit: 1 })) > 0) return false
  const stored = await scriptRuns.findOne({ _id: run._id }, { projection: { 'log.lines': 1 } })
  return nextLine >= (stored?.log?.lines ?? 0)
}

/** getScriptRunLogs: up to `limit` stored lines after `afterLine` (default: from the first retained line). */
export async function readScriptRunLogs(run: ScriptRunDoc, query: { afterLine?: number; limit: number }): Promise<ScriptRunLogsPage> {
  const start = query.afterLine ?? run.log.firstLine - 1
  const lines: ScriptRunLogLine[] = []
  const cursor = useCollections()
    .scriptRunLogs.find({ scriptRunId: run._id, chunk: { $gte: firstChunkFor(start + 1) } })
    .sort({ chunk: 1 })
  try {
    for await (const chunk of cursor) {
      for (let index = 0; index < chunk.lines.length && lines.length < query.limit; index++) {
        const number = chunk.firstLine + index
        if (number > start && number <= run.log.lines) lines.push(toLogLine(chunk.lines[index]!, number))
      }
      if (lines.length >= query.limit || chunk.firstLine + chunk.lines.length > run.log.lines) break
    }
  } finally {
    await cursor.close()
  }
  const nextLine = lines.at(-1)?.line ?? Math.min(start, run.log.lines)
  return { lines, firstLine: run.log.firstLine, nextLine, complete: await logComplete(run, nextLine) }
}

/** Chunks read per round trip by the tail (the last 50 lines lie in at most two chunks). */
const TAIL_CHUNK_BATCH = 2

/** The last lines of a run's log (at most LOG_TAIL_MAX_LINES lines and LOG_TAIL_MAX_BYTES of text), newest chunks first. */
export async function scriptRunLogTail(run: Pick<ScriptRunDoc, '_id' | 'log'>): Promise<ScriptRunLogLine[]> {
  if (run.log.lines === 0) return []
  const { scriptRunLogs } = useCollections()
  const tail: ScriptRunLogLine[] = []
  let bytes = 0
  let before: number | null = null
  for (;;) {
    const chunks = await scriptRunLogs
      .find(before === null ? { scriptRunId: run._id } : { scriptRunId: run._id, chunk: { $lt: before } })
      .sort({ chunk: -1 })
      .limit(TAIL_CHUNK_BATCH)
      .toArray()
    for (const chunk of chunks) {
      for (let index = chunk.lines.length - 1; index >= 0; index--) {
        const number = chunk.firstLine + index
        if (number > run.log.lines) continue
        const line = chunk.lines[index]!
        bytes += Buffer.byteLength(line.text, 'utf8')
        if (tail.length >= LOG_TAIL_MAX_LINES || (bytes > LOG_TAIL_MAX_BYTES && tail.length > 0)) return tail.reverse()
        tail.push(toLogLine(line, number))
      }
      before = chunk.chunk
    }
    if (chunks.length < TAIL_CHUNK_BATCH) return tail.reverse()
  }
}
