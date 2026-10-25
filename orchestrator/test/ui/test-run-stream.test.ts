import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TestRun } from '#shared/types/test-runs'
import { useTestRunStream } from '../../app/composables/useTestRuns'

// Following test runs (docs/ui.md §5.8): loading a history row fetches the run with its analyses, and only the answer
// for the run that is still followed is applied.

interface Pending {
  id: string
  resolve: () => void
}

let pending: Pending[]

function run(id: string, seqs: number[] | undefined): TestRun {
  return {
    id,
    state: 'completed',
    errors: [],
    summary: { analyses: seqs?.length ?? 0, succeeded: seqs?.length ?? 0, failed: 0 },
    ...(seqs ? { analyses: seqs.map((seq) => ({ seq, status: 'succeeded' })) } : {}),
  } as unknown as TestRun
}

beforeEach(() => {
  pending = []
  vi.stubGlobal('useApi', () => (path: string) => {
    const id = path.split('/')[3]!
    return new Promise((resolve) => pending.push({ id, resolve: () => resolve(run(id, id === 'a' ? [1, 2, 3] : [7])) }))
  })
  vi.stubGlobal('usePoll', () => ({ running: ref(false), refresh: async () => {} }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function answer(id: string): Promise<void> {
  pending.find((request) => request.id === id)!.resolve()
  for (let tick = 0; tick < 3; tick++) await Promise.resolve()
}

describe('useTestRunStream.follow', () => {
  it('ignores the late answer of a run that is no longer followed', async () => {
    const stream = effectScope().run(() => useTestRunStream())!
    stream.follow(run('a', undefined))
    stream.follow(run('b', undefined))
    await answer('b')
    await answer('a')
    expect(stream.testRun.value?.id).toBe('b')
    expect(stream.analyses.value.map((analysis) => analysis.seq)).toEqual([7])
  })
})
