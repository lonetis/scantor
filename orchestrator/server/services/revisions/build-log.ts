import type { BuildLogLine, BuildLogPage } from '#shared/types/revisions'
import type { RevisionDoc } from '../../types/documents'
import { useLogger } from '../../utils/logger'
import { getObjectStream, isS3NotFound, putObject } from '../../utils/s3'
import type { PipelineEvent } from '../pipeline/events'
import { parsePipelineEvent } from '../pipeline/events'
import { isRevisionSettled } from './mappers'

// Build logs (docs/tasks.md §9.8, docs/api.md §4.10 getRevisionBuildLog): the task-pipeline events of a revision
// build, stored as NDJSON at `build-logs/<revisionId>.ndjson`. While a build runs in this process the events are
// kept in memory (and flushed to S3 every few seconds), so the UI can follow the log live. The log is capped at
// 10 MiB: then one truncation event is added, later `log` events are dropped, and `error` and `result` events are
// kept. Line numbers are `seq + 1`.

export const BUILD_LOG_MAX_BYTES = 10 * 1024 ** 2
export const BUILD_LOG_CONTENT_TYPE = 'application/x-ndjson'
const FLUSH_INTERVAL_MS = 5000

export class BuildLog {
  readonly events: PipelineEvent[] = []
  private bytes = 0
  private truncated = false
  private dirty = false
  private timer: NodeJS.Timeout | null = null

  constructor(
    readonly key: string,
    private readonly maxBytes = BUILD_LOG_MAX_BYTES,
  ) {}

  append(event: PipelineEvent): void {
    const size = JSON.stringify(event).length + 1
    if (this.bytes + size > this.maxBytes && event.type === 'log') {
      if (!this.truncated) {
        this.truncated = true
        const marker: PipelineEvent = {
          v: 1,
          seq: event.seq,
          at: event.at,
          phase: event.phase,
          type: 'log',
          stream: 'pipeline',
          level: 'warning',
          text: `build log truncated at ${this.maxBytes} bytes; later log lines are dropped`,
        }
        this.events.push(marker)
        this.dirty = true
      }
      return
    }
    this.events.push(event)
    this.bytes += size
    this.dirty = true
  }

  toNdjson(): string {
    return this.events.map((event) => JSON.stringify(event)).join('\n') + (this.events.length > 0 ? '\n' : '')
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await putObject(this.key, this.toNdjson(), BUILD_LOG_CONTENT_TYPE)
  }

  /** Flushes to S3 every few seconds while the build runs (failures are logged and retried at the next tick). */
  startPeriodicFlush(): void {
    this.timer ??= setInterval(() => {
      this.flush().catch((error: unknown) => {
        this.dirty = true
        useLogger('revisions').warn('flushing a build log failed', { key: this.key, err: error })
      })
    }, FLUSH_INTERVAL_MS)
  }

  stopPeriodicFlush(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

/** Live build logs of the revisions this process is building. */
const live = new Map<string, BuildLog>()

/** Starts (or restarts from scratch) the live log of a revision build. */
export function startBuildLog(revisionId: string, key: string): BuildLog {
  live.get(revisionId)?.stopPeriodicFlush()
  const log = new BuildLog(key)
  live.set(revisionId, log)
  log.startPeriodicFlush()
  return log
}

/** Writes the final log to S3 and stops serving it from memory. */
export async function finishBuildLog(revisionId: string, log: BuildLog): Promise<void> {
  log.stopPeriodicFlush()
  try {
    await log.flush()
  } finally {
    if (live.get(revisionId) === log) live.delete(revisionId)
  }
}

export function toBuildLogLine(event: PipelineEvent): BuildLogLine {
  const line: BuildLogLine = { line: event.seq + 1, at: event.at, phase: event.phase, type: event.type }
  if (event.type === 'log') {
    line.stream = event.stream ?? 'pipeline'
    line.level = event.level ?? 'info'
    line.text = event.text ?? ''
  } else if (event.type === 'error' && event.error) {
    line.error = event.error
  } else if (event.type === 'result' && event.result) {
    line.result = event.result as unknown as Record<string, unknown>
  }
  return line
}

async function readStoredEvents(key: string): Promise<PipelineEvent[]> {
  let stream: NodeJS.ReadableStream
  try {
    stream = await getObjectStream(key)
  } catch (error) {
    if (isS3NotFound(error)) return []
    throw error
  }
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  return Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .map((line) => (line.trim() ? parsePipelineEvent(line) : null))
    .filter((event): event is PipelineEvent => event !== null)
}

/** One page of a revision's build log after `afterLine`. */
export async function readBuildLog(revision: RevisionDoc, afterLine: number, limit: number): Promise<BuildLogPage> {
  const current = live.get(revision._id)
  const events = current ? [...current.events] : await readStoredEvents(revision.buildLogKey)
  const pending = events.filter((event) => event.seq + 1 > afterLine)
  const page = pending.slice(0, limit)
  const nextLine = page.length > 0 ? page.at(-1)!.seq + 1 : afterLine
  const complete = !current && isRevisionSettled(revision) && pending.length <= limit
  return { lines: page.map(toBuildLogLine), nextLine, complete }
}
