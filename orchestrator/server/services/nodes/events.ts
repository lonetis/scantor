import { randomUUID } from 'node:crypto'
import type { EventLevel } from '#shared/utils/enums'
import type { EventDoc } from '../../types/documents'
import { type Logger, useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'

// Event writer of the node and runtime areas (docs/data-model.md §4.11): bounded message (1 KiB) and data (8 KiB),
// `userId: null` for admin-only node events. Writing an event never fails the operation that caused it: a failed
// insert is logged and swallowed only here, because events are an audit trail, not state.

export const EVENT_MESSAGE_MAX = 1024
export const EVENT_DATA_MAX = 8192

export interface EventInput {
  type: string
  level: EventLevel
  message: string
  userId?: string | null
  scanId?: string
  workerId?: string
  nodeId?: string
  data?: Record<string, unknown>
  at?: Date
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  // Cut on a code point boundary and mark the cut.
  return `${bytes.subarray(0, maxBytes - 3).toString('utf8').replace(/�+$/, '')}…`
}

/** Bounds `data` to EVENT_DATA_MAX bytes of JSON; oversized data keeps only a note. */
export function boundEventData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (data === undefined) return undefined
  const json = JSON.stringify(data)
  if (Buffer.byteLength(json, 'utf8') <= EVENT_DATA_MAX) return data
  return { truncated: true, bytes: Buffer.byteLength(json, 'utf8') }
}

export function buildEvent(input: EventInput): EventDoc {
  const doc: EventDoc = {
    _id: randomUUID(),
    at: input.at ?? new Date(),
    type: input.type,
    level: input.level,
    userId: input.userId ?? null,
    message: truncateUtf8(input.message, EVENT_MESSAGE_MAX),
  }
  if (input.scanId) doc.scanId = input.scanId
  if (input.workerId) doc.workerId = input.workerId
  if (input.nodeId) doc.nodeId = input.nodeId
  const data = boundEventData(input.data)
  if (data) doc.data = data
  return doc
}

/** Records events; failures are logged (events are an audit trail and never block the caller). */
export async function recordEvents(inputs: EventInput[], log: Logger = useLogger('events')): Promise<void> {
  if (inputs.length === 0) return
  try {
    await useCollections().events.insertMany(inputs.map(buildEvent), { ordered: false })
  } catch (error) {
    log.warn('recording events failed', { count: inputs.length, types: [...new Set(inputs.map((input) => input.type))], err: error })
  }
}

export async function recordEvent(input: EventInput, log?: Logger): Promise<void> {
  await recordEvents([input], log)
}
