import { randomUUID } from 'node:crypto'
import type { Collection } from 'mongodb'
import type { EventLevel } from '#shared/utils/enums'
import type { EventDoc } from '../../types/documents'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'

// Timeline events of scans and their workers (docs/data-model.md §4.11). Messages are bounded to 1 KiB and data
// to 8 KiB (§8). Events are informational: a failed write is logged and never fails the operation that caused it.

export const EVENT_MESSAGE_MAX_BYTES = 1024
export const EVENT_DATA_MAX_BYTES = 8192

export interface EventInput {
  type: string
  level: EventLevel
  /** owner of the subject; null = admin-only */
  userId: string | null
  scanId?: string
  workerId?: string
  nodeId?: string
  taskId?: string
  revisionId?: string
  message: string
  data?: Record<string, unknown>
  at?: Date
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes - 3).toString('utf8')
  // A cut inside a multi-byte character decodes to U+FFFD at the end; drop it.
  if (cut.endsWith('�')) cut = cut.slice(0, -1)
  return `${cut}...`
}

function boundedData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (data === undefined) return undefined
  const json = JSON.stringify(data)
  if (Buffer.byteLength(json, 'utf8') <= EVENT_DATA_MAX_BYTES) return data
  return { truncated: true, bytes: Buffer.byteLength(json, 'utf8') }
}

export function buildEvent(input: EventInput): EventDoc {
  const doc: EventDoc = {
    _id: randomUUID(),
    at: input.at ?? new Date(),
    type: input.type,
    level: input.level,
    userId: input.userId,
    message: truncateUtf8(input.message, EVENT_MESSAGE_MAX_BYTES),
  }
  if (input.scanId) doc.scanId = input.scanId
  if (input.workerId) doc.workerId = input.workerId
  if (input.nodeId) doc.nodeId = input.nodeId
  if (input.taskId) doc.taskId = input.taskId
  if (input.revisionId) doc.revisionId = input.revisionId
  const data = boundedData(input.data)
  if (data) doc.data = data
  return doc
}

export async function writeEvent(input: EventInput, events: Collection<EventDoc> = useCollections().events): Promise<void> {
  try {
    await events.insertOne(buildEvent(input))
  } catch (error) {
    useLogger('events').warn('writing an event failed', { type: input.type, scanId: input.scanId, err: error })
  }
}

export async function writeEvents(inputs: EventInput[], events: Collection<EventDoc> = useCollections().events): Promise<void> {
  if (inputs.length === 0) return
  try {
    await events.insertMany(inputs.map(buildEvent), { ordered: false })
  } catch (error) {
    useLogger('events').warn('writing events failed', { count: inputs.length, err: error })
  }
}

/** `scan.stateChanged` (docs/data-model.md §4.11): level by target state. */
export function stateChangedEvent(scan: { _id: string; userId: string }, from: string, to: string, reason: string, message?: string): EventInput {
  const level: EventLevel = to === 'failed' ? 'error' : to === 'paused' && reason !== 'user' ? 'warning' : 'info'
  return {
    type: 'scan.stateChanged',
    level,
    userId: scan.userId,
    scanId: scan._id,
    message: message ?? `scan ${from} → ${to} (${reason})`,
    data: { from, to, reason },
  }
}
