import { Transform, type TransformCallback } from 'node:stream'
import type { BuildErrorPhase } from '#shared/utils/enums'
import type { BuildErrorDoc, DescriptionDoc, ScanSettingsDefaultsDoc } from '../../types/documents'

// Task-pipeline events (docs/tasks.md §9.8): NDJSON on the stdout of `scantor task build`, one event per line, in
// order. The final event is always a `result` with the BuildResult.

export type PipelinePhase = Exclude<BuildErrorPhase, 'config' | 'schedule'>
export type PipelineStream = 'pipeline' | 'build' | 'stdout' | 'stderr' | 'check'

export interface PackSummary {
  packSha256: string
  packBytes: number
  fileCount: number
  bytes: number
}

export interface BuildResultImage {
  ref: string
  id: string
  repository?: string
  tag?: string
  digest?: string
  bytes: number
  platform: { os: string; arch: string; variant?: string }
}

export interface BuildResult {
  ok: boolean
  pack: PackSummary | null
  manifest: Record<string, unknown> | null
  settingsDefaults: ScanSettingsDefaultsDoc | null
  language: string | null
  privileged: boolean | null
  baseImage: { ref: string; digest: string } | null
  image: BuildResultImage | null
  description: DescriptionDoc | null
  errors: BuildErrorDoc[]
  warnings: string[]
  durationsMs: Record<string, number>
}

export interface PipelineEvent {
  v: number
  seq: number
  at: string
  phase: PipelinePhase
  type: 'log' | 'error' | 'result'
  stream?: PipelineStream
  level?: 'info' | 'warning'
  text?: string
  error?: BuildErrorDoc
  result?: BuildResult
}

/** The `log` event the binary emits before it blocks on the push gate (docs/tasks.md §9.7). */
export const PUSH_GATE_TEXT = 'waiting for push gate'

export function isPushGateEvent(event: PipelineEvent): boolean {
  return event.phase === 'push' && event.type === 'log' && event.text === PUSH_GATE_TEXT
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates the shape of one decoded event line; null for anything that is not an event. */
export function parsePipelineEvent(line: string): PipelineEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (typeof value.seq !== 'number' || typeof value.phase !== 'string' || typeof value.type !== 'string') return null
  if (value.type !== 'log' && value.type !== 'error' && value.type !== 'result') return null
  return value as unknown as PipelineEvent
}

/**
 * Splits a byte stream into lines (without the newline). Lines longer than `maxLineBytes` are dropped and
 * reported through `onOversized` instead of growing the buffer without bound.
 */
export class LineSplitter extends Transform {
  private buffer = ''
  private dropping = false

  constructor(
    private readonly maxLineBytes: number,
    private readonly onOversized: (length: number) => void = () => {},
  ) {
    super({ readableObjectMode: true })
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const text = this.buffer + chunk.toString('utf8')
    const lines = text.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (this.dropping) {
        this.dropping = false
        continue
      }
      if (line.length > 0) this.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
    if (this.buffer.length > this.maxLineBytes) {
      this.onOversized(this.buffer.length)
      this.buffer = ''
      this.dropping = true
    }
    callback()
  }

  override _flush(callback: TransformCallback): void {
    if (this.buffer.length > 0 && !this.dropping) this.push(this.buffer)
    this.buffer = ''
    callback()
  }
}

/** A BuildError of phase `platform` (Docker unreachable, internal failures, driver timeouts). */
export function platformError(message: string): BuildErrorDoc {
  return { phase: 'platform', message: message.slice(0, 4096) }
}
