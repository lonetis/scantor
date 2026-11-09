import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, ScriptRunDoc, ScriptRunLogChunkDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// The script-run log (docs/scripts.md): chunks of at most 500 lines numbered from 1 (the newest stays open and fills
// up), redaction and secret masking, the 16 KiB line cut, the ingestion rate limit, the head + tail retention, the
// resume after a crash between the chunk and the state write, the follower cursor (only for stored lines), coalesced
// flushes while the store fails, a writer whose run was deleted, and the reads (pages seeking by chunk, completion
// only once the run's job ended, the tail across chunks).

const store = {
  scriptRuns: new FakeCollection<ScriptRunDoc>('scriptRuns'),
  scriptRunLogs: new FakeCollection<ScriptRunLogChunkDoc>('scriptRunLogs'),
  jobs: new FakeCollection<JobDoc>('jobs'),
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))

const logs = await import('../../../server/services/script-runs/logs')
const { ScriptRunLogWriter, emptyLogState, readScriptRunLogs, scriptRunLogTail, sinceOf, timestampNanos, truncateUtf8 } = logs

const RUN_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const quiet = { warn: () => {} }

function writer(options: { maxLogBytes?: number; secrets?: string[]; now?: () => number; log?: { warn: (...args: unknown[]) => void } } = {}) {
  return new ScriptRunLogWriter(RUN_ID, emptyLogState(), {
    maxLogBytes: options.maxLogBytes ?? 32 * 1024 ** 2,
    secrets: options.secrets,
    log: options.log ?? quiet,
    now: options.now,
  })
}

function chunks(): ScriptRunLogChunkDoc[] {
  return (store.scriptRunLogs.docs as unknown as ScriptRunLogChunkDoc[]).sort((a, b) => a.chunk - b.chunk)
}

function storedTexts(): string[] {
  return chunks().flatMap((chunk) => chunk.lines.map((line) => line.text))
}

function run(state: Partial<ScriptRunDoc> = {}): ScriptRunDoc {
  const doc = store.scriptRuns.docs.find((candidate) => candidate._id === RUN_ID) as ScriptRunDoc | undefined
  return { _id: RUN_ID, state: 'running', log: doc?.log ?? emptyLogState(), ...state } as ScriptRunDoc
}

beforeEach(() => {
  for (const collection of Object.values(store)) {
    collection.docs.length = 0
    collection.filters.length = 0
  }
  store.scriptRuns.docs.push({ _id: RUN_ID, state: 'running', log: emptyLogState() })
})

describe('ScriptRunLogWriter', () => {
  it('stores lines in chunks of at most 500 numbered from 1 and keeps the run state in step', async () => {
    const log = writer()
    for (let index = 0; index < 1200; index++) log.append('stdout', `line ${index + 1}`)
    await log.close()
    const chunks = store.scriptRunLogs.docs as unknown as ScriptRunLogChunkDoc[]
    expect(chunks.map((chunk) => [chunk._id, chunk.firstLine, chunk.lines.length])).toEqual([
      [`${RUN_ID}-0`, 1, 500],
      [`${RUN_ID}-1`, 501, 500],
      [`${RUN_ID}-2`, 1001, 200],
    ])
    // Chunk 2 stays open for the next lines.
    expect(run().log).toMatchObject({ lines: 1200, nextChunk: 2, firstLine: 1, droppedLines: 0 })
  })

  it('fills the open chunk across flushes instead of writing one chunk per flush', async () => {
    const log = writer()
    for (let index = 0; index < 30; index++) {
      log.append('stdout', `progress ${index + 1}`)
      await log.flush()
    }
    for (let index = 30; index < 520; index++) log.append('stdout', `progress ${index + 1}`)
    await log.close()
    expect(chunks().map((chunk) => [chunk.chunk, chunk.firstLine, chunk.lines.length])).toEqual([
      [0, 1, 500],
      [1, 501, 20],
    ])
    expect(run().log).toMatchObject({ lines: 520, nextChunk: 1 })
    const tail = await scriptRunLogTail(run())
    expect(tail).toHaveLength(50)
    expect(tail.map((line) => line.line)).toEqual(Array.from({ length: 50 }, (_, index) => 471 + index))
  })

  it('leaves lines that arrive during a write to the next flush', async () => {
    const log = writer()
    let writes = 0
    const replaceOne = store.scriptRunLogs.replaceOne.bind(store.scriptRunLogs)
    store.scriptRunLogs.replaceOne = (async (...args: Parameters<typeof replaceOne>) => {
      // Two container lines arrive during each of the first two round trips.
      if (++writes <= 2) {
        log.append('stdout', `steady ${writes}a`)
        log.append('stdout', `steady ${writes}b`)
      }
      return replaceOne(...args)
    }) as typeof replaceOne
    for (let index = 0; index < 600; index++) log.append('stdout', `burst ${index}`)
    await log.flush()
    // One write for the first 500 lines, one for the rest of the burst; the steady lines wait.
    expect(writes).toBe(2)
    expect(run().log.lines).toBe(600)
    await log.close()
    expect(chunks().map((chunk) => chunk.lines.length)).toEqual([500, 104])
  })

  it('redacts tokens and presigned signatures, masks the run secrets and cuts long lines', async () => {
    const log = writer({ secrets: ['hunter2-secret', 'abc'] })
    log.append('stderr', 'token ssr_3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG')
    log.append('stdout', 'GET https://s3/x?X-Amz-Signature=deadbeef&y=1 with hunter2-secret and abc')
    log.append('stdout', 'é'.repeat(20_000))
    await log.close()
    const [chunk] = store.scriptRunLogs.docs as unknown as ScriptRunLogChunkDoc[]
    expect(chunk!.lines[0]!.text).toBe('token ssr_***')
    expect(chunk!.lines[1]!.text).toBe('GET https://s3/x?X-Amz-Signature=***&y=1 with *** and abc')
    const long = chunk!.lines[2]!.text
    expect(Buffer.byteLength(long, 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(long.endsWith(' [line truncated]')).toBe(true)
    expect(long).not.toContain('�')
  })

  it('drops lines over the ingestion rate with one marker per window', async () => {
    let now = 1_000_000
    const log = writer({ now: () => now })
    for (let index = 0; index < 20_010; index++) log.append('stdout', 'x')
    now += 10_000
    log.append('stdout', 'after the window')
    await log.close()
    const state = run().log
    expect(state.droppedLines).toBe(10)
    const lines = (store.scriptRunLogs.docs as unknown as ScriptRunLogChunkDoc[]).flatMap((chunk) => chunk.lines)
    expect(lines.filter((line) => line.stream === 'system')).toHaveLength(1)
    expect(lines.at(-1)!.text).toBe('after the window')
    expect(state.lines).toBe(20_000 + 1 + 1)
  })

  it('keeps the head and the newest chunks within the byte limit and marks the gap once', async () => {
    const log = writer({ maxLogBytes: 2 * 1024 * 1024 })
    const line = 'y'.repeat(4096)
    for (let index = 0; index < 2000; index++) log.append('stdout', line)
    await log.close()
    await log.close()
    const state = run().log
    const chunks = (store.scriptRunLogs.docs as unknown as ScriptRunLogChunkDoc[]).sort((a, b) => a.chunk - b.chunk)
    expect(chunks[0]!.chunk).toBe(0)
    expect(state.bytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 16 * 1024)
    expect(state.droppedLines).toBeGreaterThan(0)
    const markers = chunks.flatMap((chunk) => chunk.lines).filter((entry) => entry.stream === 'system')
    expect(markers).toHaveLength(1)
    // Line numbers continue across the gap.
    expect(chunks.at(-1)!.firstLine + chunks.at(-1)!.lines.length - 1).toBe(state.lines)
  })

  it('appends the marker again when a later retention pass deletes the chunk that held it', async () => {
    const log = writer({ maxLogBytes: 2 * 1024 * 1024 })
    const line = 'z'.repeat(1024)
    // One chunk per flush: every pass from the fifth on deletes the oldest chunk after the head.
    for (let round = 0; round < 10; round++) {
      for (let index = 0; index < 500; index++) log.append('stdout', line)
      await log.flush()
    }
    await log.close()
    const stored = chunks()
    const markers = stored
      .flatMap((chunk) => chunk.lines.map((entry, index) => ({ ...entry, line: chunk.firstLine + index, chunk: chunk.chunk })))
      .filter((entry) => entry.stream === 'system')
    expect(markers).toHaveLength(1)
    expect(markers[0]!.text).toContain('lines in between are dropped')
    // Only the chunk holding it is flagged, and the marker lies after the gap.
    expect(stored.filter((chunk) => chunk.retentionMarker).map((chunk) => chunk.chunk)).toEqual([markers[0]!.chunk])
    const gapEnd = stored.find((chunk, index) => index > 0 && chunk.chunk !== stored[index - 1]!.chunk + 1)!
    expect(markers[0]!.line).toBeGreaterThanOrEqual(gapEnd.firstLine)

    // A writer that resumes knows the stored marker and does not append another one.
    const resumed = new ScriptRunLogWriter(RUN_ID, run().log, { maxLogBytes: 2 * 1024 * 1024, log: quiet })
    await resumed.resume()
    resumed.append('stdout', 'after the resume')
    await resumed.close()
    expect(storedTexts().filter((text) => text.includes('lines in between are dropped'))).toHaveLength(1)
  })

  it('appends the marker on resume when a gap has none (a crash before the marker was stored)', async () => {
    for (const [chunk, firstLine] of [
      [0, 1],
      [2, 1001],
    ] as const) {
      store.scriptRunLogs.docs.push({
        _id: `${RUN_ID}-${chunk}`,
        scriptRunId: RUN_ID,
        chunk,
        firstLine,
        lines: Array.from({ length: chunk === 0 ? 500 : 1 }, () => ({ at: new Date(), stream: 'stdout' as const, text: 'x' })),
        bytes: chunk === 0 ? 500 : 1,
      })
    }
    const log = new ScriptRunLogWriter(RUN_ID, { ...emptyLogState(), lines: 1001, bytes: 501, nextChunk: 2 }, { maxLogBytes: 1024 ** 2, log: quiet })
    await log.resume()
    await log.close()
    expect(chunks().at(-1)).toMatchObject({ chunk: 2, firstLine: 1001, retentionMarker: true })
    expect(
      chunks()
        .at(-1)!
        .lines.map((line) => line.stream),
    ).toEqual(['stdout', 'system'])
    expect(run().log).toMatchObject({ lines: 1002 })
  })

  it('resumes after a chunk was written without its state update and reopens it', async () => {
    store.scriptRunLogs.docs.push({
      _id: `${RUN_ID}-0`,
      scriptRunId: RUN_ID,
      chunk: 0,
      firstLine: 1,
      lines: [
        { at: new Date(), stream: 'stdout', text: 'a' },
        { at: new Date(), stream: 'stdout', text: 'b' },
      ],
      bytes: 2,
    })
    const log = new ScriptRunLogWriter(RUN_ID, emptyLogState(), { maxLogBytes: 1024 ** 2, log: quiet })
    await log.resume()
    log.append('stdout', 'c')
    await log.close()
    expect(run().log).toMatchObject({ lines: 3, nextChunk: 0, bytes: 3 })
    expect(chunks().map((chunk) => [chunk.chunk, chunk.firstLine, chunk.lines.map((line) => line.text)])).toEqual([[0, 1, ['a', 'b', 'c']]])
  })

  it('resumes after a full chunk with the next one', async () => {
    const first = writer()
    for (let index = 0; index < 500; index++) first.append('stdout', `line ${index + 1}`)
    await first.close()
    const log = new ScriptRunLogWriter(RUN_ID, { ...emptyLogState(), lines: 500, bytes: 9999, nextChunk: 0 }, { maxLogBytes: 1024 ** 2, log: quiet })
    await log.resume()
    log.append('stdout', 'line 501')
    await log.close()
    expect(chunks().map((chunk) => [chunk.chunk, chunk.firstLine, chunk.lines.length])).toEqual([
      [0, 1, 500],
      [1, 501, 1],
    ])
    expect(run().log).toMatchObject({ lines: 501, nextChunk: 1, bytes: chunks().reduce((sum, chunk) => sum + chunk.bytes, 0) })
  })

  it('stores the cursor of the last stored line, not of lines appended during the write', async () => {
    const log = writer()
    log.append('stdout', 'stored', undefined, '2026-11-08T20:00:00.1Z')
    const replaceOne = store.scriptRunLogs.replaceOne.bind(store.scriptRunLogs)
    let once = true
    store.scriptRunLogs.replaceOne = (async (...args: Parameters<typeof replaceOne>) => {
      const result = await replaceOne(...args)
      if (once) {
        once = false
        log.append('stdout', 'arrived during the write', undefined, '2026-11-08T21:00:00.000000001Z')
      }
      return result
    }) as typeof replaceOne
    await log.flush()
    // A crash now resumes after the stored line and reads the other one again.
    expect(run().log.cursor).toEqual({ ts: '2026-11-08T20:00:00.1Z', countAtTs: 1 })
    expect(storedTexts()).toEqual(['stored'])
    expect(log.cursor).toEqual({ ts: '2026-11-08T21:00:00.000000001Z', countAtTs: 1 })
    await log.close()
    expect(run().log.cursor).toEqual({ ts: '2026-11-08T21:00:00.000000001Z', countAtTs: 1 })
  })

  it('coalesces flushes while the store fails, warns once, bounds what waits and recovers', async () => {
    const warnings: unknown[] = []
    let now = 1_000_000
    const log = writer({ now: () => now, log: { warn: (...args: unknown[]) => warnings.push(args) } })
    let failing = true
    let attempts = 0
    const replaceOne = store.scriptRunLogs.replaceOne.bind(store.scriptRunLogs)
    store.scriptRunLogs.replaceOne = (async (...args: Parameters<typeof replaceOne>) => {
      attempts++
      if (failing) throw new Error('mongo is down')
      return replaceOne(...args)
    }) as typeof replaceOne
    for (let index = 0; index < 2000; index++) log.append('stdout', `a ${index}`)
    await log.flush()
    // The threshold flushes of 1500 more lines joined one write; after it failed only flush() retries.
    expect(attempts).toBe(1)
    expect(warnings).toHaveLength(1)
    // Within the rate limit (two windows), but beyond one window of lines waiting while the writes fail.
    for (let index = 0; index < 15_000; index++) log.append('stdout', `b ${index}`)
    now += 10_000
    for (let index = 0; index < 15_000; index++) log.append('stdout', `c ${index}`)
    await log.flush()
    expect(attempts).toBe(2)
    expect(warnings).toHaveLength(1)
    failing = false
    await log.close()
    expect(run().log).toMatchObject({ lines: 20_001, droppedLines: 12_000 })
    expect(storedTexts().slice(-2)).toEqual(['c 2999', 'the log store is behind; lines are dropped until it catches up'])
  })

  it('stops and removes its chunks when the run document is gone', async () => {
    const log = writer()
    log.start()
    log.append('stdout', 'one')
    await log.flush()
    expect(chunks()).toHaveLength(1)
    store.scriptRuns.docs.length = 0
    log.append('stdout', 'after the run was deleted')
    await log.flush()
    expect(chunks()).toHaveLength(0)
    log.append('stdout', 'ignored')
    await log.close()
    expect(chunks()).toHaveLength(0)
  })

  it('counts container frames per timestamp for the follower cursor', () => {
    const log = writer()
    log.append('stdout', 'one', undefined, '2026-11-08T20:00:00.1Z')
    log.append('stdout', 'two', undefined, '2026-11-08T20:00:00.1Z')
    log.append('system', 'platform line')
    expect(log.cursor).toEqual({ ts: '2026-11-08T20:00:00.1Z', countAtTs: 2 })
    log.append('stderr', 'three', undefined, '2026-11-08T20:00:01Z')
    expect(log.cursor).toEqual({ ts: '2026-11-08T20:00:01Z', countAtTs: 1 })
  })
})

describe('reading the log', () => {
  beforeEach(async () => {
    const log = writer()
    for (let index = 0; index < 700; index++) log.append(index % 2 === 0 ? 'stdout' : 'stderr', `line ${index + 1}`)
    await log.close()
  })

  it('pages after a line and reports completion only for a finished run whose job ended', async () => {
    const first = await readScriptRunLogs(run(), { limit: 3 })
    expect(first.lines.map((line) => line.line)).toEqual([1, 2, 3])
    expect(first).toMatchObject({ firstLine: 1, nextLine: 3, complete: false })
    const later = await readScriptRunLogs(run(), { afterLine: 498, limit: 4 })
    expect(later.lines.map((line) => [line.line, line.text])).toEqual([
      [499, 'line 499'],
      [500, 'line 500'],
      [501, 'line 501'],
      [502, 'line 502'],
    ])
    const end = await readScriptRunLogs(run({ state: 'completed' }), { afterLine: 699, limit: 10 })
    expect(end).toMatchObject({ nextLine: 700, complete: true })
    expect(end.lines).toHaveLength(1)
    const past = await readScriptRunLogs(run({ state: 'completed' }), { afterLine: 700, limit: 10 })
    expect(past).toMatchObject({ lines: [], nextLine: 700, complete: true })
    // A pending cancel counts as finished, but its job still stores the lines of the container stop.
    store.jobs.docs.push({ _id: 'job', kind: 'scriptRun', subject: { kind: 'scriptRun', id: RUN_ID }, state: 'running', active: true })
    const stopping = await readScriptRunLogs(run({ state: 'running', cancelRequest: { at: new Date(), reason: null } }), { afterLine: 700, limit: 10 })
    expect(stopping).toMatchObject({ lines: [], nextLine: 700, complete: false })
    // The job stored one more line and ended; a reader holding the older document still learns that a line follows.
    const log = new ScriptRunLogWriter(RUN_ID, run().log, { maxLogBytes: 32 * 1024 ** 2, log: quiet })
    await log.resume()
    log.append('system', 'the script run was cancelled')
    const stale = run({ state: 'cancelled' })
    await log.close()
    store.jobs.docs[0]!.active = false
    expect(await readScriptRunLogs(stale, { afterLine: 700, limit: 10 })).toMatchObject({ complete: false })
    expect(await readScriptRunLogs(run({ state: 'cancelled' }), { afterLine: 700, limit: 10 })).toMatchObject({ nextLine: 701, complete: true })
  })

  it('seeks the chunk of the first line it returns', async () => {
    await readScriptRunLogs(run(), { afterLine: 600, limit: 10 })
    expect(store.scriptRunLogs.filters.at(-1)).toEqual({ scriptRunId: RUN_ID, chunk: { $gte: 1 } })
    await readScriptRunLogs(run(), { afterLine: 500, limit: 10 })
    expect(store.scriptRunLogs.filters.at(-1)).toEqual({ scriptRunId: RUN_ID, chunk: { $gte: 1 } })
    await readScriptRunLogs(run(), { afterLine: 499, limit: 10 })
    expect(store.scriptRunLogs.filters.at(-1)).toEqual({ scriptRunId: RUN_ID, chunk: { $gte: 0 } })
  })

  it('returns the last 50 lines as the tail', async () => {
    const tail = await scriptRunLogTail(run())
    expect(tail).toHaveLength(50)
    expect(tail[0]!.line).toBe(651)
    expect(tail.at(-1)).toMatchObject({ line: 700, stream: 'stderr', text: 'line 700' })
  })
})

describe('timestamps', () => {
  it('parses Docker RFC3339Nano timestamps with trimmed fractions', () => {
    expect(timestampNanos('2026-11-08T20:00:00Z')).toBe(1_794_168_000_000_000_000n)
    expect(timestampNanos('2026-11-08T20:00:00.5Z')).toBe(1_794_168_000_500_000_000n)
    expect(timestampNanos('2026-11-08T20:00:00.000000001Z')).toBe(1_794_168_000_000_000_001n)
    expect(timestampNanos('nonsense')).toBeNull()
  })

  it('resumes one second before the cursor', () => {
    expect(sinceOf('2026-11-08T20:00:00.5Z')).toBe('1794167999.500000000')
  })

  it('cuts UTF-8 without splitting characters', () => {
    expect(truncateUtf8('aé', 2)).toEqual({ text: 'a', truncated: true })
    expect(truncateUtf8('abc', 3)).toEqual({ text: 'abc', truncated: false })
  })
})
