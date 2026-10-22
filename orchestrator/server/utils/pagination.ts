import type { Collection, Document, Filter, Sort } from 'mongodb'
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '#shared/schemas/common'
import type { Page } from '#shared/types/common'
import { apiError } from './errors'

// Cursor pagination (docs/api.md §1.8): `?limit` (default 50, max 200) and an opaque base64url `?cursor`.
// Lists sort newest first (`createdAt` desc, then `_id` desc) unless a route states otherwise; the cursor holds the
// sort key of the last returned document. Filters built here are combined with `$and`, never by object spread.

export interface CreatedAtCursor {
  /** createdAt of the last item, epoch ms */
  t: number
  /** _id of the last item */
  i: string
}

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** Decodes a cursor and validates it with `guard`; anything else is 400 validationFailed. */
export function decodeCursor<T>(cursor: string, guard: (value: unknown) => value is T): T {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    value = undefined
  }
  if (!guard(value)) {
    throw apiError('validationFailed', 'invalid cursor', { issues: [{ path: 'cursor', message: 'invalid cursor' }] })
  }
  return value
}

export function isCreatedAtCursor(value: unknown): value is CreatedAtCursor {
  const candidate = value as CreatedAtCursor | null
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    Number.isSafeInteger(candidate.t) &&
    typeof candidate.i === 'string' &&
    candidate.i.length > 0 &&
    candidate.i.length <= 128
  )
}

export function pageLimit(limit: number | undefined, max = MAX_PAGE_LIMIT, fallback = DEFAULT_PAGE_LIMIT): number {
  if (limit === undefined) return fallback
  return Math.min(Math.max(1, Math.trunc(limit)), max)
}

/** The filter that selects documents after the cursor in `{createdAt: -1, _id: -1}` order. */
export function createdAtCursorFilter<TDoc extends Document & { _id: string; createdAt: Date }>(cursor: CreatedAtCursor): Filter<TDoc> {
  const createdAt = new Date(cursor.t)
  return { $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: cursor.i } }] } as Filter<TDoc>
}

export interface PageOptions {
  limit?: number
  cursor?: string
  maxLimit?: number
}

/**
 * Fetches one newest-first page of `collection` matching `filter`. Fetches limit + 1 documents to know whether a
 * next page exists. `map` turns documents into API representations.
 */
export async function findPage<TDoc extends Document & { _id: string; createdAt: Date }, TItem>(
  collection: Collection<TDoc>,
  filter: Filter<TDoc>,
  options: PageOptions,
  map: (doc: TDoc) => TItem | Promise<TItem>,
): Promise<Page<TItem>> {
  const limit = pageLimit(options.limit, options.maxLimit)
  const clauses: Filter<TDoc>[] = [filter]
  if (options.cursor) {
    clauses.push(createdAtCursorFilter<TDoc>(decodeCursor(options.cursor, isCreatedAtCursor)))
  }
  const sort: Sort = { createdAt: -1, _id: -1 }
  const docs = (await collection
    .find(clauses.length === 1 ? clauses[0]! : ({ $and: clauses } as Filter<TDoc>))
    .sort(sort)
    .limit(limit + 1)
    .toArray()) as TDoc[]
  const hasMore = docs.length > limit
  const pageDocs = hasMore ? docs.slice(0, limit) : docs
  const last = pageDocs.at(-1)
  return {
    items: await Promise.all(pageDocs.map(map)),
    nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.getTime(), i: last._id } satisfies CreatedAtCursor) : null,
  }
}
