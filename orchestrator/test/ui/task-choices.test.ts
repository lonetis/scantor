import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_SEARCH_DEBOUNCE_MS, useTaskChoices } from '../../app/composables/useTasks'

// The task choices of the new-scan picker and the scans list's task filter (docs/ui.md §5.11, §5.12): a server search
// over every task, not one page filtered in the browser, with the chosen task always among the items.

interface Request {
  path: string
  q: string | null
}

const task = (id: string) => ({ id, name: `task-${id}` })
let requests: Request[]

beforeEach(() => {
  vi.useFakeTimers()
  requests = []
  vi.stubGlobal('apiQuery', (query: Record<string, unknown>) => query)
  vi.stubGlobal('useApi', () => async (path: string, options: { query?: { q: string | null } } = {}) => {
    requests.push({ path, q: options.query?.q ?? null })
    if (path !== '/api/tasks') return task(decodeURIComponent(path.slice('/api/tasks/'.length)))
    return { items: options.query?.q ? [task(`match-${options.query.q}`)] : [task('newest'), task('older')], nextCursor: null }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(TASK_SEARCH_DEBOUNCE_MS + 1)
}

function setup() {
  const scope = effectScope()
  const choices = scope.run(() => useTaskChoices())!
  return { choices, ids: () => choices.tasks.value.map((item) => item.id) }
}

describe('useTaskChoices', () => {
  it('asks the server for the typed text instead of filtering one page', async () => {
    const { choices, ids } = setup()
    await choices.load()
    expect(ids()).toEqual(['newest', 'older'])
    choices.search.value = '  old-task  '
    await settle()
    expect(requests.at(-1)).toEqual({ path: '/api/tasks', q: 'old-task' })
    expect(ids()).toEqual(['match-old-task'])
  })

  it('keeps the chosen task among the items while the search shows others', async () => {
    const { choices, ids } = setup()
    await choices.load()
    choices.choose('older')
    choices.search.value = 'x'
    await settle()
    expect(ids()).toEqual(['older', 'match-x'])
    choices.choose(null)
    expect(ids()).toEqual(['match-x'])
  })

  it('loads a preselected task by id or name, also one beyond the first page', async () => {
    const { choices, ids } = setup()
    await choices.load()
    const resolved = await choices.resolve('ancient')
    expect(resolved.id).toBe('ancient')
    expect(requests.at(-1)).toEqual({ path: '/api/tasks/ancient', q: null })
    expect(ids()).toEqual(['ancient', 'newest', 'older'])
  })
})
