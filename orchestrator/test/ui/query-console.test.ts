import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery, type QueryBody } from '../../app/composables/useQuery'

// The query console (docs/ui.md §5.13.4): "Load more" continues the query that produced the shown items, not
// whatever the editors hold when the button is pressed.

let bodies: QueryBody[]

beforeEach(() => {
  bodies = []
  vi.stubGlobal('useAnalyses', () => ({
    query: async (body: QueryBody) => {
      bodies.push(body)
      const after = body.afterSeq ?? 0
      return { items: [{ seq: after + 1 }], nextCursor: String(after + 1) }
    },
    aggregate: async () => ({ items: [], truncated: false }),
  }))
  vi.stubGlobal('useUiPrefs', () => ({ getQueries: () => [], pushQuery: () => {} }))
  vi.stubGlobal('errorIssues', () => [])
  vi.stubGlobal('toApiError', (cause: unknown) => cause)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useQuery.loadMore', () => {
  it('pages through the query that was run, after the editors changed', async () => {
    const query = effectScope().run(() => useQuery('scan-1'))!
    query.inputs.filter = '{"status": "failed"}'
    query.inputs.limit = 20
    await query.run()
    query.inputs.filter = '{"status": "succeeded"}'
    query.inputs.limit = 5
    await query.loadMore()
    expect(bodies).toEqual([
      { filter: { status: 'failed' }, limit: 20 },
      { filter: { status: 'failed' }, limit: 20, afterSeq: 1 },
    ])
    expect(query.items.value).toEqual([{ seq: 1 }, { seq: 2 }])
  })

  it('still loads more while the editors hold invalid JSON', async () => {
    const query = effectScope().run(() => useQuery('scan-1'))!
    await query.run()
    query.inputs.filter = '{"status": '
    await query.loadMore()
    expect(bodies.at(-1)).toEqual({ filter: { status: 'failed' }, limit: 20, afterSeq: 1 })
  })
})
