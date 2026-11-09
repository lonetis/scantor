import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptRunDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'
import { OWNER, RUN, SCAN, SCRIPT } from './helpers'

// Progress and checkpoints of script runs (docs/scripts.md): at most one write per run per interval, the latest value
// always written (when the interval ends, at flush, at the component stop), never a newer value replaced by an older one.

const scriptRuns = new FakeCollection<ScriptRunDoc>('scriptRuns')
vi.mock('../../../server/utils/mongo', () => ({ useCollections: () => ({ scriptRuns: scriptRuns.asCollection() }) }))

vi.mock('../../../server/utils/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/keys')>()
  const keys = actual.createKeyring('script runtime state test secret')
  return { ...actual, useKeys: () => keys }
})

const { ThrottledWriter, flushAllScriptRunState, flushScriptRunState, reportProgress, saveCheckpoint } =
  await import('../../../server/services/script-runtime/state')
const { sealScriptRunSecrets } = await import('../../../server/services/script-runtime/secrets')

const principal = { kind: 'scriptRun' as const, scriptRun: { id: RUN, userId: OWNER, scriptId: SCRIPT, scanIds: [SCAN], limit: null } }

describe('ThrottledWriter', () => {
  let now = 0
  const writes: [string, number][] = []
  let failNext = false
  const writer = () =>
    new ThrottledWriter<number>(
      'value',
      1000,
      async (key, value) => {
        if (failNext) {
          failNext = false
          throw new Error('database down')
        }
        writes.push([key, value])
      },
      () => now,
    )

  beforeEach(() => {
    vi.useFakeTimers()
    now = 0
    writes.length = 0
    failNext = false
  })

  afterEach(() => vi.useRealTimers())

  const advance = async (ms: number) => {
    now += ms
    await vi.advanceTimersByTimeAsync(ms)
  }

  it('writes the first value at once and the latest of an interval when it ends', async () => {
    const throttled = writer()
    await throttled.submit('a', 1)
    expect(writes).toEqual([['a', 1]])
    await throttled.submit('a', 2)
    await throttled.submit('a', 3)
    expect(writes).toEqual([['a', 1]])
    await advance(999)
    expect(writes).toEqual([['a', 1]])
    await advance(1)
    expect(writes).toEqual([
      ['a', 1],
      ['a', 3],
    ])
    // The interval restarts with the timed write.
    await throttled.submit('a', 4)
    expect(writes).toHaveLength(2)
    await advance(1000)
    expect(writes.at(-1)).toEqual(['a', 4])
  })

  it('throttles each key on its own', async () => {
    const throttled = writer()
    await throttled.submit('a', 1)
    await throttled.submit('b', 1)
    await throttled.submit('a', 2)
    expect(writes).toEqual([
      ['a', 1],
      ['b', 1],
    ])
    expect(throttled.pendingKeys()).toEqual(['a'])
  })

  it('writes a value at once after a quiet interval', async () => {
    const throttled = writer()
    await throttled.submit('a', 1)
    await advance(5000)
    await throttled.submit('a', 2)
    expect(writes).toEqual([
      ['a', 1],
      ['a', 2],
    ])
  })

  it('flushes the pending value of a key at once and forgets the key', async () => {
    const throttled = writer()
    await throttled.submit('a', 1)
    await throttled.submit('a', 2)
    await throttled.flush('a')
    expect(writes).toEqual([
      ['a', 1],
      ['a', 2],
    ])
    await advance(5000)
    expect(writes).toHaveLength(2)
    await throttled.flush('a')
    expect(writes).toHaveLength(2)
    // After a flush the next value is written at once.
    await throttled.submit('a', 3)
    expect(writes.at(-1)).toEqual(['a', 3])
  })

  it('keeps a value whose write failed and retries it', async () => {
    const throttled = writer()
    failNext = true
    await throttled.submit('a', 1)
    expect(writes).toEqual([])
    expect(throttled.pendingKeys()).toEqual(['a'])
    await advance(1000)
    expect(writes).toEqual([['a', 1]])
  })

  it('throws from a failed flush but keeps the value pending', async () => {
    const throttled = writer()
    await throttled.submit('a', 1)
    await throttled.submit('a', 2)
    failNext = true
    await expect(throttled.flush('a')).rejects.toThrow('database down')
    expect(throttled.pendingKeys()).toEqual(['a'])
    await advance(1000)
    expect(writes.at(-1)).toEqual(['a', 2])
  })

  it('writes everything pending at the stop and every later value at once', async () => {
    const throttled = writer()
    await throttled.submit('a', 1)
    await throttled.submit('a', 2)
    await throttled.submit('b', 1)
    await throttled.submit('b', 2)
    await throttled.flushAll()
    expect(writes).toEqual([
      ['a', 1],
      ['b', 1],
      ['a', 2],
      ['b', 2],
    ])
    await throttled.submit('a', 3)
    expect(writes.at(-1)).toEqual(['a', 3])
    throttled.resume()
  })
})

describe('reportProgress and saveCheckpoint', () => {
  beforeEach(async () => {
    await scriptRuns.deleteMany({})
    await scriptRuns.insertOne({ _id: RUN, userId: OWNER, state: 'running', progress: null, checkpoint: null } as unknown as ScriptRunDoc)
  })

  afterEach(async () => {
    await flushScriptRunState(RUN)
  })

  it('stores the progress of the run and holds a quick follow-up in memory until the flush', async () => {
    expect(await reportProgress(principal, { done: 1, total: 10 }, new Date('2026-01-01T00:00:00Z'))).toEqual({ state: 'running' })
    expect((await scriptRuns.findOne({ _id: RUN }))?.progress).toEqual({ done: 1, total: 10, message: null, updatedAt: new Date('2026-01-01T00:00:00Z') })
    await reportProgress(principal, { done: 2, total: null, message: 'half' }, new Date('2026-01-01T00:00:00.500Z'))
    expect((await scriptRuns.findOne({ _id: RUN }))?.progress?.done).toBe(1)
    await flushScriptRunState(RUN)
    expect((await scriptRuns.findOne({ _id: RUN }))?.progress).toEqual({
      done: 2,
      total: null,
      message: 'half',
      updatedAt: new Date('2026-01-01T00:00:00.500Z'),
    })
  })

  it("masks the run's secret values and tokens in the progress message", async () => {
    await scriptRuns.updateOne({ _id: RUN }, { $set: { secrets: sealScriptRunSecrets(RUN, { API_TOKEN: 'TOPSECRET1' }) } })
    await reportProgress(principal, { done: 1, total: null, message: `using TOPSECRET1 and ssr_${RUN}.${'A'.repeat(43)}` }, new Date('2026-01-01T00:00:00Z'))
    expect((await scriptRuns.findOne({ _id: RUN }))?.progress?.message).toBe('using *** and ssr_***')
  })

  it('never replaces a newer progress with an older one', async () => {
    await scriptRuns.updateOne({ _id: RUN }, { $set: { progress: { done: 9, total: null, message: null, updatedAt: new Date('2026-01-02T00:00:00Z') } } })
    await reportProgress(principal, { done: 1 }, new Date('2026-01-01T00:00:00Z'))
    expect((await scriptRuns.findOne({ _id: RUN }))?.progress?.done).toBe(9)
  })

  it('stores the checkpoint with its size and acceptance time', async () => {
    const savedAt = new Date('2026-01-01T00:00:00Z')
    expect(await saveCheckpoint(principal, { state: { afterSeq: 41, counts: [1, 2] } }, savedAt)).toEqual({ savedAt: '2026-01-01T00:00:00.000Z' })
    expect((await scriptRuns.findOne({ _id: RUN }))?.checkpoint).toEqual({ state: { afterSeq: 41, counts: [1, 2] }, savedAt, bytes: 30 })
    await saveCheckpoint(principal, { state: { afterSeq: 99 } }, new Date('2026-01-01T00:00:05Z'))
    expect((await scriptRuns.findOne({ _id: RUN }))?.checkpoint?.state).toEqual({ afterSeq: 41, counts: [1, 2] })
    await flushAllScriptRunState()
    expect((await scriptRuns.findOne({ _id: RUN }))?.checkpoint?.state).toEqual({ afterSeq: 99 })
  })

  it('refuses a checkpoint above 1 MiB (413) and one MongoDB cannot store (400)', async () => {
    await expect(saveCheckpoint(principal, { state: 'x'.repeat(1024 ** 2) })).rejects.toMatchObject({ code: 'payloadTooLarge' })
    await expect(saveCheckpoint(principal, { state: { $where: 1 } })).rejects.toMatchObject({ code: 'validationFailed' })
    expect((await scriptRuns.findOne({ _id: RUN }))?.checkpoint).toBeNull()
  })
})
