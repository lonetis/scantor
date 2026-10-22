import { describe, expect, it } from 'vitest'
import {
  type CompletionCollections,
  recountScan,
  statsFromCounts,
  terminalOf,
  tryCompleteScan,
} from '../../../server/services/scans/completion'
import type { AnalysisDoc, EventDoc, ScanDoc } from '../../../server/types/documents'
import type { AnalysisStatus } from '#shared/utils/enums'
import { FakeCollection, matches } from '../../helpers/fake-collection'
import { analysisDoc, scanDoc as fixtureScan } from './fixtures'

// Recount and completion (docs/data-model.md §6.1, §7 invariant 5; docs/queue.md §6.9): the recount is the
// authoritative aggregation of analysis statuses, completion the single conditional update running → completed |
// failed. The MongoDB behaviour of the same code is covered by test/services/scans/broker.integration.test.ts.

/** The fake collection plus the `$match` + `$group by $status` aggregation the recount runs. */
class FakeAnalyses extends FakeCollection<AnalysisDoc> {
  aggregate(pipeline: Record<string, unknown>[]) {
    const match = (pipeline[0]?.$match ?? {}) as Record<string, unknown>
    const counts = new Map<string, number>()
    for (const doc of this.docs.filter((candidate) => matches(candidate, match))) {
      counts.set(doc.status as string, (counts.get(doc.status as string) ?? 0) + 1)
    }
    return { toArray: async () => [...counts].map(([status, n]) => ({ _id: status, n })) }
  }
}

const SCAN_ID = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
const T0 = new Date('2026-10-21T10:00:00.000Z')

function scanDoc(overrides: Parameters<typeof fixtureScan>[0] = {}): ScanDoc {
  return fixtureScan({ _id: SCAN_ID, ...overrides, scheduling: { epoch: 1, ...overrides.scheduling } })
}

function analysis(seq: number, status: AnalysisStatus, scanId = SCAN_ID): AnalysisDoc {
  return analysisDoc(scanId, seq, status)
}

async function setup(scan: ScanDoc, statuses: AnalysisStatus[]) {
  const scans = new FakeCollection<ScanDoc>('scans')
  const analyses = new FakeAnalyses('analyses')
  const events = new FakeCollection<EventDoc>('events')
  await scans.insertOne(scan)
  for (const [seq, status] of statuses.entries()) await analyses.insertOne(analysis(seq, status))
  await analyses.insertOne(analysis(0, 'failed', 'other-scan'))
  const deps = { scans: scans.asCollection(), analyses: analyses.asCollection(), events: events.asCollection() } as CompletionCollections
  return { scans, analyses, events, deps }
}

describe('statsFromCounts', () => {
  it('maps status counts onto stats', () => {
    const stats = statsFromCounts({ succeeded: 5, failed: 2, retrying: 1 }, { state: 'running', scheduling: { confirmed: 10 } })
    expect(stats).toEqual({ pending: 0, retrying: 1, succeeded: 5, failed: 2, lost: 0, cancelled: 0 })
    expect(terminalOf(stats)).toBe(7)
  })

  it('counts never-run seqs of cancelled scans as cancelled', () => {
    const stats = statsFromCounts({ succeeded: 5, failed: 1, cancelled: 2 }, { state: 'cancelled', scheduling: { confirmed: 20 } })
    expect(stats.cancelled).toBe(14)
    expect(terminalOf(stats)).toBe(20)
  })
})

describe('recountScan', () => {
  it('writes the exact counts of the scan and recountedAt', async () => {
    const { scans, deps } = await setup(scanDoc({ stats: { ...scanDoc().stats, succeeded: 99, ratePerMin: 12 } }), ['succeeded', 'failed', 'retrying', 'pending', 'lost'])
    const stats = await recountScan(SCAN_ID, deps)
    expect(stats).toMatchObject({ pending: 1, retrying: 1, succeeded: 1, failed: 1, lost: 1, cancelled: 0, ratePerMin: 12 })
    const stored = await scans.findOne({ _id: SCAN_ID })
    expect(stored?.stats).toMatchObject({ pending: 1, retrying: 1, succeeded: 1, failed: 1, lost: 1, cancelled: 0, ratePerMin: 12 })
    expect(stored?.stats.recountedAt).toBeInstanceOf(Date)
  })
})

describe('tryCompleteScan', () => {
  it('completes a running scan once every confirmed analysis is final', async () => {
    const { scans, events, deps } = await setup(scanDoc({ scheduling: { confirmed: 3 } }), ['succeeded', 'failed', 'lost'])
    expect(await tryCompleteScan(SCAN_ID, 'ingestor', deps)).toBe(true)
    const stored = await scans.findOne({ _id: SCAN_ID })
    expect(stored).toMatchObject({ state: 'completed', stateReason: { code: 'completed' }, stats: { succeeded: 1, failed: 1, lost: 1 } })
    expect(stored?.completedAt).toBeInstanceOf(Date)
    expect(events.docs).toMatchObject([{ type: 'scan.stateChanged', scanId: SCAN_ID, level: 'info', data: { from: 'running', to: 'completed', reason: 'completed' } }])
  })

  it('ends failed when scheduling failed', async () => {
    const error = { type: 'validation' as const, phase: 'schedule' as const, message: 'schedule() is not deterministic', retryable: false, attempt: 1, at: T0 }
    const { scans, events, deps } = await setup(scanDoc({ scheduling: { state: 'failed', confirmed: 2, error } }), ['succeeded', 'succeeded'])
    expect(await tryCompleteScan(SCAN_ID, 'schedulerDone', deps)).toBe(true)
    expect(await scans.findOne({ _id: SCAN_ID })).toMatchObject({ state: 'failed', stateReason: { code: 'schedulingFailed' } })
    expect(events.docs[0]).toMatchObject({ level: 'error', data: { to: 'failed', reason: 'schedulingFailed' } })
  })

  it('records the stalled reason for a completion after stall detection', async () => {
    const { scans, deps } = await setup(scanDoc({ scheduling: { confirmed: 2 } }), ['succeeded', 'lost'])
    expect(await tryCompleteScan(SCAN_ID, 'stalled', deps)).toBe(true)
    expect(await scans.findOne({ _id: SCAN_ID })).toMatchObject({ state: 'completed', stateReason: { code: 'stalled' } })
  })

  it('does not complete while analyses are unfinished, but stores the recount', async () => {
    const { scans, deps } = await setup(scanDoc({ scheduling: { confirmed: 3 } }), ['succeeded', 'retrying', 'pending'])
    expect(await tryCompleteScan(SCAN_ID, 'periodic', deps)).toBe(false)
    expect(await scans.findOne({ _id: SCAN_ID })).toMatchObject({ state: 'running', stats: { succeeded: 1, retrying: 1, pending: 1 } })
  })

  it('does not complete with fewer documents than confirmed seqs', async () => {
    const { deps } = await setup(scanDoc({ scheduling: { confirmed: 4 } }), ['succeeded', 'succeeded', 'succeeded'])
    expect(await tryCompleteScan(SCAN_ID, 'periodic', deps)).toBe(false)
  })

  it.each([['pending'], ['running'], ['retrying']] as const)('never completes while scheduling is %s', async (scheduling) => {
    const { deps } = await setup(scanDoc({ scheduling: { state: scheduling, confirmed: 1 } }), ['succeeded'])
    expect(await tryCompleteScan(SCAN_ID, 'periodic', deps)).toBe(false)
  })

  it.each([['paused'], ['creating'], ['cancelled'], ['completed']] as const)('never completes a %s scan', async (state) => {
    const { scans, deps } = await setup(scanDoc({ state, scheduling: { confirmed: 1 } }), ['succeeded'])
    expect(await tryCompleteScan(SCAN_ID, 'periodic', deps)).toBe(false)
    expect((await scans.findOne({ _id: SCAN_ID }))?.state).toBe(state)
  })

  it('is idempotent', async () => {
    const { events, deps } = await setup(scanDoc({ scheduling: { confirmed: 1 } }), ['succeeded'])
    expect(await tryCompleteScan(SCAN_ID, 'ingestor', deps)).toBe(true)
    expect(await tryCompleteScan(SCAN_ID, 'periodic', deps)).toBe(false)
    expect(events.docs).toHaveLength(1)
  })

  it('completes an empty scan whose scheduling confirmed nothing', async () => {
    const { scans, deps } = await setup(scanDoc({ scheduling: { confirmed: 0 } }), [])
    expect(await tryCompleteScan(SCAN_ID, 'schedulerDone', deps)).toBe(true)
    expect((await scans.findOne({ _id: SCAN_ID }))?.state).toBe('completed')
  })

  it('returns false for unknown scans', async () => {
    const { deps } = await setup(scanDoc(), [])
    expect(await tryCompleteScan('0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11', 'periodic', deps)).toBe(false)
  })
})
