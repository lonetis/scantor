import { describe, expect, it } from 'vitest'
import { createdAtCursorFilter, decodeCursor, encodeCursor, findPage, isCreatedAtCursor, pageLimit } from '../../server/utils/pagination'
import { FakeCollection } from '../helpers/fake-collection'

// Cursor pagination (docs/api.md §1.8).

describe('cursors', () => {
  it('round-trips opaque base64url cursors', () => {
    const cursor = encodeCursor({ t: 1761040800000, i: 'abc' })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(cursor, isCreatedAtCursor)).toEqual({ t: 1761040800000, i: 'abc' })
  })

  it.each(['not base64 json', encodeCursor({ t: 'x', i: 'abc' }), encodeCursor({ t: 1 }), encodeCursor([1, 2])])('rejects %j', (cursor) => {
    expect(() => decodeCursor(cursor, isCreatedAtCursor)).toThrow('invalid cursor')
  })

  it('clamps limits', () => {
    expect(pageLimit(undefined)).toBe(50)
    expect(pageLimit(500)).toBe(200)
    expect(pageLimit(0)).toBe(1)
    expect(pageLimit(5000, 1000)).toBe(1000)
  })

  it('builds the createdAt/_id seek filter', () => {
    expect(createdAtCursorFilter({ t: 1000, i: 'b' })).toEqual({
      $or: [{ createdAt: { $lt: new Date(1000) } }, { createdAt: new Date(1000), _id: { $lt: 'b' } }],
    })
  })
})

describe('findPage', () => {
  it('pages newest first without gaps or duplicates, also across equal timestamps', async () => {
    const collection = new FakeCollection<{ _id: string; createdAt: Date; userId: string }>('items')
    for (let index = 0; index < 7; index++) {
      collection.docs.push({ _id: `id-${index}`, createdAt: new Date(Math.floor(index / 2) * 1000), userId: index === 3 ? 'other' : 'me' })
    }
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await findPage(collection.asCollection(), { userId: 'me' }, { limit: 2, cursor }, (doc) => doc._id)
      seen.push(...page.items)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen).toEqual(['id-6', 'id-5', 'id-4', 'id-2', 'id-1', 'id-0'])
  })
})
