import type { Filter } from 'mongodb'
import type { ListScanEventsQuery, ListScansQuery } from '#shared/schemas/scans'
import type { ItemList, Page } from '#shared/types/common'
import type { Event } from '#shared/types/events'
import type { Condition, Scan, ScanSummary } from '#shared/types/scans'
import { isUuid } from '#shared/utils/slug'
import type { EventDoc, ScanDoc } from '../../types/documents'
import { ownerFilter } from '../../utils/authz'
import { decodeCursor, encodeCursor, findPage, pageLimit } from '../../utils/pagination'
import { useCollections } from '../../utils/mongo'
import type { UserPrincipal } from '../../utils/principal'
import { isoDate } from '../../utils/serialize'
import { sortConditions } from './conditions'
import { toApiCondition, toApiScan, toScanSummary } from './mappers'
import { workerStateCounts } from './workers'

// Read side of the scans tag (docs/api.md §4.13): listScans, the Scan representation, conditions and events.

/** `listScans` hides `deleting`/`deleted` scans unless the state filter names them. */
export const LISTED_BY_DEFAULT = ['creating', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const

export async function listScans(principal: UserPrincipal, query: ListScansQuery): Promise<Page<ScanSummary>> {
  const clauses: Filter<ScanDoc>[] = [ownerFilter(principal, query.userId)]
  clauses.push({ state: { $in: query.state && query.state.length > 0 ? query.state : [...LISTED_BY_DEFAULT] } })
  if (query.task) clauses.push(isUuid(query.task) ? { 'task.id': query.task.toLowerCase() } : { 'task.name': query.task })
  return findPage(useCollections().scans, { $and: clauses }, { limit: query.limit, cursor: query.cursor }, toScanSummary)
}

/** The full `Scan` representation (with the worker summary). */
export async function scanRepresentation(scan: ScanDoc): Promise<Scan> {
  return toApiScan(scan, await workerStateCounts(scan._id))
}

/** Settled for `getScan?wait`: not creating or running (docs/api.md §1.9). */
export function scanSettled(scan: Pick<ScanDoc, 'state'>): boolean {
  return scan.state !== 'creating' && scan.state !== 'running'
}

export function scanConditions(scan: ScanDoc): ItemList<Condition> {
  return { items: sortConditions(scan.conditions).map(toApiCondition) }
}

// ── events ──────────────────────────────────────────────────────────────────

interface AtCursor {
  t: number
  i: string
}

function isAtCursor(value: unknown): value is AtCursor {
  const candidate = value as AtCursor | null
  return typeof candidate === 'object' && candidate !== null && Number.isSafeInteger(candidate.t) && typeof candidate.i === 'string' && candidate.i.length <= 128
}

export function toApiEvent(doc: EventDoc): Event {
  const event: Event = { id: doc._id, at: isoDate(doc.at), type: doc.type, level: doc.level, userId: doc.userId, message: doc.message }
  if (doc.scanId) event.scanId = doc.scanId
  if (doc.taskId) event.taskId = doc.taskId
  if (doc.revisionId) event.revisionId = doc.revisionId
  if (doc.workerId) event.workerId = doc.workerId
  if (doc.nodeId) event.nodeId = doc.nodeId
  if (doc.data) event.data = doc.data
  return event
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** listScanEvents: newest first (index {scanId: 1, at: -1}); `type` is exact or a prefix ending in a dot. */
export async function listScanEvents(scan: Pick<ScanDoc, '_id'>, query: ListScanEventsQuery): Promise<Page<Event>> {
  const { events } = useCollections()
  const limit = pageLimit(query.limit)
  const clauses: Filter<EventDoc>[] = [{ scanId: scan._id }]
  if (query.type) clauses.push({ type: query.type.endsWith('.') ? { $regex: `^${escapeRegex(query.type)}` } : query.type })
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor, isAtCursor)
    const at = new Date(cursor.t)
    clauses.push({ $or: [{ at: { $lt: at } }, { at, _id: { $lt: cursor.i } }] })
  }
  const docs = await events.find({ $and: clauses }).sort({ at: -1, _id: -1 }).limit(limit + 1).toArray()
  const page = docs.slice(0, limit)
  const last = page.at(-1)
  return {
    items: page.map(toApiEvent),
    nextCursor: docs.length > limit && last ? encodeCursor({ t: last.at.getTime(), i: last._id } satisfies AtCursor) : null,
  }
}
