import { describe, expect, it } from 'vitest'
import { useCursorList, type CursorPage } from '../../app/composables/useCursorList'

// "Load more" lists (docs/ui.md §7): `loading` covers reset() and loadMore(), `refreshing` covers refresh(), which
// the polls and the navbar "Refresh" buttons call (§5, the button spins while the refresh runs).

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

describe('useCursorList', () => {
  it('reports a running refresh as refreshing, not as loading', async () => {
    const pending: Deferred<CursorPage<number>>[] = []
    const list = useCursorList<number>(() => {
      const page = deferred<CursorPage<number>>()
      pending.push(page)
      return page.promise
    }, { immediate: false })

    const first = list.reset()
    expect(list.loading.value).toBe(true)
    expect(list.refreshing.value).toBe(false)
    pending.shift()!.resolve({ items: [1], nextCursor: null })
    await first

    const refresh = list.refresh()
    expect(list.refreshing.value).toBe(true)
    expect(list.loading.value).toBe(false)
    pending.shift()!.resolve({ items: [1, 2], nextCursor: null })
    await refresh
    expect(list.refreshing.value).toBe(false)
    expect(list.items.value).toEqual([1, 2])
  })

  it('stays refreshing until the last of overlapping refreshes ends', async () => {
    const pending: Deferred<CursorPage<number>>[] = []
    const list = useCursorList<number>(() => {
      const page = deferred<CursorPage<number>>()
      pending.push(page)
      return page.promise
    }, { immediate: false })

    const poll = list.refresh()
    const click = list.refresh()
    pending.shift()!.resolve({ items: [1], nextCursor: null })
    await poll
    expect(list.refreshing.value).toBe(true)
    pending.shift()!.resolve({ items: [1], nextCursor: null })
    await click
    expect(list.refreshing.value).toBe(false)
  })

  it('ends refreshing when a refresh fails or a reset makes it stale', async () => {
    let fail = true
    const list = useCursorList<number>(async () => {
      if (fail) throw new Error('unreachable')
      return { items: [3], nextCursor: null }
    }, { immediate: false })
    await expect(list.refresh()).rejects.toThrow('unreachable')
    expect(list.refreshing.value).toBe(false)

    fail = false
    const stale = list.refresh()
    await list.reset()
    await stale
    expect(list.refreshing.value).toBe(false)
    expect(list.items.value).toEqual([3])
  })

  it('marks the pages of a poll\'s refresh as background requests, and only those (docs/ui.md §8)', async () => {
    const requests: { cursor: string | null, background: boolean }[] = []
    const list = useCursorList<string>(async (cursor, { background }) => {
      requests.push({ cursor, background })
      return cursor === null ? { items: ['a'], nextCursor: '2' } : { items: ['b'], nextCursor: null }
    }, { immediate: false })
    await list.reset()
    await list.loadMore()
    await list.refresh()
    await list.refresh({ background: true })
    expect(requests).toEqual([
      { cursor: null, background: false },
      { cursor: '2', background: false },
      { cursor: null, background: false },
      { cursor: '2', background: false },
      { cursor: null, background: true },
      { cursor: '2', background: true },
    ])
  })

  describe('a refresh that overlaps "Load more"', () => {
    // Pages are requested by cursor: null is the first page, "2" the second.
    function pagedList() {
      const pending: { cursor: string | null, page: Deferred<CursorPage<string>> }[] = []
      const list = useCursorList<string>((cursor) => {
        const page = deferred<CursorPage<string>>()
        pending.push({ cursor, page })
        return page.promise
      }, { immediate: false })
      // Answers the pending request for `cursor`, once the list has sent it (a refresh reads its pages in turn).
      const answer = async (cursor: string | null, result: CursorPage<string>) => {
        for (let tick = 0; tick < 10 && !pending.some((request) => request.cursor === cursor); tick++) await Promise.resolve()
        const index = pending.findIndex((request) => request.cursor === cursor)
        expect(index, `a pending request for cursor ${String(cursor)}`).toBeGreaterThanOrEqual(0)
        pending.splice(index, 1)[0]!.page.resolve(result)
      }
      return { list, pending, answer }
    }

    it('keeps the page that "Load more" appended while the refresh was in flight (UI-SCAN-004)', async () => {
      const { list, pending, answer } = pagedList()
      const first = list.reset()
      await answer(null, { items: ['c', 'b'], nextCursor: '2' })
      await first

      const refresh = list.refresh()
      const more = list.loadMore()
      await answer('2', { items: ['a'], nextCursor: null })
      await more
      expect(list.items.value).toEqual(['c', 'b', 'a'])
      await answer(null, { items: ['d', 'c'], nextCursor: '2' })
      await refresh
      expect(list.items.value).toEqual(['c', 'b', 'a'])
      expect(list.refreshing.value).toBe(false)
      expect(list.hasMore.value).toBe(false)

      // The next refresh re-reads both pages.
      const next = list.refresh()
      await answer(null, { items: ['d', 'c'], nextCursor: '2' })
      await answer('2', { items: ['b', 'a'], nextCursor: null })
      await next
      expect(list.items.value).toEqual(['d', 'c', 'b', 'a'])
      expect(pending).toEqual([])
    })

    it('drops a refresh that started while "Load more" was loading and ended after it', async () => {
      const { list, answer } = pagedList()
      const first = list.reset()
      await answer(null, { items: ['c', 'b'], nextCursor: '2' })
      await first

      const more = list.loadMore()
      const refresh = list.refresh()
      await answer('2', { items: ['a'], nextCursor: null })
      await more
      await answer(null, { items: ['d', 'c'], nextCursor: '2' })
      await refresh
      expect(list.items.value).toEqual(['c', 'b', 'a'])
    })

    it('appends a "Load more" page that arrives after the refresh ended', async () => {
      const { list, answer } = pagedList()
      const first = list.reset()
      await answer(null, { items: ['c', 'b'], nextCursor: '2' })
      await first

      const more = list.loadMore()
      const refresh = list.refresh()
      await answer(null, { items: ['d', 'c'], nextCursor: '2' })
      await refresh
      expect(list.items.value).toEqual(['d', 'c'])
      await answer('2', { items: ['b', 'a'], nextCursor: null })
      await more
      expect(list.items.value).toEqual(['d', 'c', 'b', 'a'])
      expect(list.hasMore.value).toBe(false)
    })
  })

  describe('a refresh bounded by maxRefreshPages (docs/ui.md §5.13.2)', () => {
    interface Row { id: string, version: number }
    // Pages of two rows; the cursor is the index of the page's first row.
    function boundedList(rows: { ids: string[], version: number }) {
      const list = useCursorList<Row>(async (cursor) => {
        const start = cursor === null ? 0 : Number(cursor)
        const end = start + 2
        return {
          items: rows.ids.slice(start, end).map((id) => ({ id, version: rows.version })),
          nextCursor: end < rows.ids.length ? String(end) : null,
        }
      }, { immediate: false, maxRefreshPages: 2 })
      return list
    }
    const ids = (list: { items: { value: Row[] } }) => list.items.value.map((row) => row.id)

    it('keeps the rows loaded beyond the re-read pages, with their cursor', async () => {
      const rows = { ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], version: 0 }
      const list = boundedList(rows)
      await list.reset()
      await list.loadMore()
      await list.loadMore()
      expect(ids(list)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])

      rows.version = 1
      await list.refresh()
      expect(ids(list)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
      expect(list.items.value.map((row) => row.version)).toEqual([1, 1, 1, 1, 0, 0])
      expect(list.hasMore.value).toBe(true)
      await list.loadMore()
      expect(ids(list)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
      expect(list.hasMore.value).toBe(false)
    })

    it('joins the kept rows after the last re-read one when new rows pushed the others down', async () => {
      const rows = { ids: ['c', 'd', 'e', 'f', 'g', 'h', 'i'], version: 0 }
      const list = boundedList(rows)
      await list.reset()
      await list.loadMore()
      await list.loadMore()
      expect(ids(list)).toEqual(['c', 'd', 'e', 'f', 'g', 'h'])

      rows.ids = ['a', 'b', ...rows.ids]
      await list.refresh()
      expect(ids(list)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])
    })

    it('replaces everything when the re-read reaches the end of the list', async () => {
      const rows = { ids: ['a', 'b', 'c', 'd', 'e', 'f'], version: 0 }
      const list = boundedList(rows)
      await list.reset()
      await list.loadMore()
      await list.loadMore()

      rows.ids = ['a', 'b', 'c']
      await list.refresh()
      expect(ids(list)).toEqual(['a', 'b', 'c'])
      expect(list.hasMore.value).toBe(false)
    })
  })
})
