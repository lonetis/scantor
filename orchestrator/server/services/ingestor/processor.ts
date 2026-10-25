import { BSON, type Collection, type Document } from 'mongodb'
import type { ScanDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import type { Logger } from '../../utils/logger'
import {
  analysesCompleted,
  breakerTrips,
  ingestBatchSize,
  ingestFlushSeconds,
  ingestMessages,
  ingestWriteFailed,
} from '../metrics/catalogue'
import { type AnalysisWrite, buildMinimalFailedWrite, type WriteTarget } from './build-document'
import type { IngestItem } from './items'
import type { CachedScan, ScanStateCache } from './scan-cache'
import { BreakerWindow, RateWindow } from './windows'
import { type ItemResult, type WriteItem, writeBatch, writeIsolated } from './writer'

/*
 * One flush of the ingestor (docs/queue.md §6.4–§6.10), shared by the result consumer and the dead-letter consumer:
 *
 *   1. load the scans of the batch (cache) and apply checks 4–7 per item: drop items of unknown, deleting or
 *      deleted scans and of rounds above the scan's (re-read fresh first), record unusable messages as minimal
 *      failed documents;
 *   2. write every guarded upsert with one unordered bulkWrite plus its follow-up (writer.ts); a whole-batch failure
 *      throws BatchWriteError and the consumer nacks;
 *   3. after the consumer settled the deliveries, `finish` updates the live hint counters, the rate window and the
 *      breaker per scan, and triggers completion checks.
 *
 * Between flushes a timer (`start`) writes the rate of scans whose window changed without a flush, so the rate and
 * the API's ETA of a scan whose results stopped decay to 0 instead of keeping the last value (docs/queue.md §6.8).
 */

/** Largest update document check 7 accepts (MongoDB's limit is 16 MiB per document). */
export const MAX_UPDATE_BYTES = 15 * 1024 * 1024
export const COMPLETION_TRIGGER_INTERVAL_MS = 10_000
/** How often rates that changed without a flush are written (the window has one-minute buckets). */
export const RATE_REFRESH_INTERVAL_MS = 30_000
const SWEEP_INTERVAL_MS = 60_000

export type ItemOutcome = 'applied' | 'failedRecorded' | 'duplicate' | 'dropped' | 'writeFailed'

/** Functions of the scans area (contracts of server/services/scans/{lifecycle,completion}.ts). */
export interface IngestorHooks {
  pauseScanBySystem(scanId: string, reason: 'failureRate' | 'brokerAlarm' | (string & {}), details?: object): Promise<void>
  tryCompleteScan(scanId: string, trigger: string): Promise<boolean>
}

export type ProcessorConfig = Pick<Config, 'maxResultBytes' | 'breakerMinAttempts' | 'breakerRatio' | 'breakerWindowMs'>

export interface ProcessorDeps {
  analyses: Collection<Document>
  scans: Collection<ScanDoc>
  cache: ScanStateCache
  config: ProcessorConfig
  hooks: IngestorHooks
  log: Logger
  now?: () => Date
}

interface ScanTally {
  succeeded: number
  failed: number
  retrying: number
}

export interface FlushResult {
  outcomes: ItemOutcome[]
  /** applied writes per scan */
  tallies: Map<string, ScanTally>
  /** the scans as the flush saw them */
  scans: Map<string, CachedScan>
  now: Date
}

/** What a completion trigger needs of a scan (§6.9). */
interface CompletionView {
  id: string
  state: CachedScan['state']
  round: number
  schedulingState: CachedScan['schedulingState']
  confirmed: number
  /** hint terminal count: succeeded + failed + lost + cancelled */
  terminal: number
}

const COMPLETION_PROJECTION = {
  state: 1,
  round: 1,
  'scheduling.state': 1,
  'scheduling.confirmed': 1,
  'stats.succeeded': 1,
  'stats.failed': 1,
  'stats.lost': 1,
  'stats.cancelled': 1,
} as const

type CompletionDoc = Pick<ScanDoc, '_id' | 'state' | 'round'> & {
  scheduling?: Partial<Pick<ScanDoc['scheduling'], 'state' | 'confirmed'>>
  stats?: Partial<ScanDoc['stats']>
}

function completionViewOf(doc: CompletionDoc): CompletionView {
  const stats = doc.stats ?? {}
  return {
    id: doc._id,
    state: doc.state,
    round: doc.round,
    schedulingState: doc.scheduling?.state ?? null,
    confirmed: doc.scheduling?.confirmed ?? 0,
    terminal: (stats.succeeded ?? 0) + (stats.failed ?? 0) + (stats.lost ?? 0) + (stats.cancelled ?? 0),
  }
}

/** The fallback when the hint update failed: the scan as the flush loaded it plus this flush's results. */
function cachedCompletionView(scan: CachedScan, tally: ScanTally): CompletionView {
  const { succeeded, failed, lost, cancelled } = scan.stats
  return {
    id: scan.id,
    state: scan.state,
    round: scan.round,
    schedulingState: scan.schedulingState,
    confirmed: scan.confirmed,
    terminal: succeeded + failed + lost + cancelled + tally.succeeded + tally.failed,
  }
}

const GONE_STATES = new Set(['deleting', 'deleted'])

/** Check 7: the reason why an update document cannot be stored, or null. */
export function bsonProblem(update: Document): string | null {
  let size: number
  try {
    size = BSON.serialize(update).length
  } catch (error) {
    return (error as Error).message
  }
  return size >= MAX_UPDATE_BYTES ? `the analysis update is ${size} bytes, above the ${MAX_UPDATE_BYTES}-byte limit` : null
}

export class BatchProcessor {
  private readonly rate = new RateWindow()
  private readonly breaker: BreakerWindow
  private readonly lastCompletionTrigger = new Map<string, { round: number; at: number }>()
  /** checks held back by the interval, run when it ends (one per scan) */
  private readonly deferredCompletions = new Map<string, NodeJS.Timeout>()
  private readonly now: () => Date
  private lastSweep = 0
  private rateTimer: NodeJS.Timeout | null = null
  private refreshing = false

  constructor(private readonly deps: ProcessorDeps) {
    this.breaker = new BreakerWindow(deps.config.breakerWindowMs)
    this.now = deps.now ?? (() => new Date())
  }

  /** Checks 4–5: the scans of the batch, re-read fresh for items whose round is above the cached one. */
  private async scansFor(items: readonly IngestItem[]): Promise<Map<string, CachedScan>> {
    const scans = await this.deps.cache.load(items.map((item) => item.scanId))
    const stale = items.filter((item) => {
      const scan = scans.get(item.scanId)
      return scan?.exists && item.round > scan.round
    })
    if (stale.length > 0) {
      for (const [id, scan] of await this.deps.cache.reload(stale.map((item) => item.scanId))) scans.set(id, scan)
    }
    return scans
  }

  private accepts(item: IngestItem, scan: CachedScan | undefined): boolean {
    if (!scan || !scan.exists || (scan.state && GONE_STATES.has(scan.state))) return false
    if (item.round > scan.round) {
      this.deps.log.warn('futureRound: dropping a message whose round is above the scan round', {
        scanId: item.scanId,
        seq: item.seq,
        round: item.round,
        scanRound: scan.round,
      })
      return false
    }
    return true
  }

  private writeItem(item: IngestItem, target: WriteTarget): WriteItem {
    const fallback = (reason: string) => buildMinimalFailedWrite(target, { reason, executionId: item.executionId })
    let write: AnalysisWrite = item.prepare(target)
    const problem = bsonProblem(write.update)
    if (problem) write = fallback(`result could not be stored: ${problem}`)
    return { write, fallback }
  }

  /**
   * Checks and writes a batch. Throws BatchWriteError on a whole-batch failure (nothing may be acknowledged then).
   * Items whose analysis id is in `isolate` are written one per bulkWrite (isolation mode, §6.6).
   */
  async process(items: readonly IngestItem[], isolate: ReadonlySet<string> = new Set()): Promise<FlushResult> {
    const started = performance.now()
    const now = this.now()
    const scans = await this.scansFor(items)
    const outcomes: ItemOutcome[] = items.map(() => 'dropped')
    const batch: { index: number; item: WriteItem }[] = []
    const isolated: { index: number; item: WriteItem }[] = []
    for (const [index, item] of items.entries()) {
      const scan = scans.get(item.scanId)
      if (!this.accepts(item, scan)) continue
      const target: WriteTarget = { scanId: item.scanId, seq: item.seq, round: item.round, attempt: item.attempt, userId: scan!.userId, now }
      const writeItem = this.writeItem(item, target)
      ;(isolate.has(writeItem.write.id) ? isolated : batch).push({ index, item: writeItem })
    }

    const results: (ItemResult | null)[] = items.map(() => null)
    const batchResults = await writeBatch(this.deps.analyses, batch.map((entry) => entry.item), this.deps.log)
    for (const [position, entry] of batch.entries()) results[entry.index] = batchResults[position]!
    for (const entry of isolated) results[entry.index] = await writeIsolated(this.deps.analyses, entry.item, this.deps.log)

    const tallies = new Map<string, ScanTally>()
    for (const [index, result] of results.entries()) {
      if (!result) continue
      const item = items[index]!
      if (result.status === 'duplicate') {
        outcomes[index] = 'duplicate'
      } else if (result.status === 'writeFailed') {
        outcomes[index] = 'writeFailed'
      } else {
        outcomes[index] = result.write.minimal ? 'failedRecorded' : 'applied'
        const tally = tallies.get(item.scanId) ?? { succeeded: 0, failed: 0, retrying: 0 }
        tally[result.write.outcome] += 1
        tallies.set(item.scanId, tally)
      }
    }
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome === 'writeFailed') ingestWriteFailed.inc()
      else ingestMessages.inc({ kind: items[index]!.kind, outcome })
    }
    ingestBatchSize.observe(undefined, items.length)
    ingestFlushSeconds.observe(undefined, (performance.now() - started) / 1000)
    return { outcomes, tallies, scans, now }
  }

  /** Bounds the per-scan in-memory state over the process lifetime. */
  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweep < SWEEP_INTERVAL_MS) return
    this.lastSweep = nowMs
    this.rate.sweep(nowMs)
    this.breaker.sweep(nowMs)
    for (const [scanId, last] of this.lastCompletionTrigger) {
      if (nowMs - last.at > COMPLETION_TRIGGER_INTERVAL_MS) this.lastCompletionTrigger.delete(scanId)
    }
  }

  /** Step 6 of §6.4: hint counters, rate, breaker and completion triggers; failures are logged, never thrown. */
  async finish(result: FlushResult): Promise<void> {
    const nowMs = result.now.getTime()
    this.sweep(nowMs)
    const counted = new Map<string, CompletionView>()
    for (const [scanId, tally] of result.tallies) {
      const terminal = tally.succeeded + tally.failed
      if (tally.succeeded > 0) analysesCompleted.inc({ status: 'succeeded' }, tally.succeeded)
      if (tally.failed > 0) analysesCompleted.inc({ status: 'failed' }, tally.failed)
      this.rate.record(scanId, terminal, nowMs)
      this.breaker.record(scanId, tally.succeeded, tally.failed + tally.retrying, nowMs, result.scans.get(scanId)?.pausedAt ?? null)
      const rate = this.rate.ratePerMin(scanId, nowMs)
      try {
        const updated = await this.deps.scans.findOneAndUpdate(
          { _id: scanId },
          {
            $inc: { 'stats.succeeded': tally.succeeded, 'stats.failed': tally.failed, 'stats.retrying': tally.retrying },
            $set: { 'stats.ratePerMin': rate, updatedAt: result.now },
          },
          { returnDocument: 'after', projection: COMPLETION_PROJECTION },
        )
        this.rate.markStored(scanId, rate)
        if (updated) counted.set(scanId, completionViewOf(updated as CompletionDoc))
      } catch (error) {
        this.deps.log.warn('updating the live scan counters failed', { scanId, err: error })
      }
    }
    for (const scanId of this.breaker.scanIds()) {
      const scan = result.scans.get(scanId) ?? this.deps.cache.get(scanId)
      if (scan && scan.state !== 'running') this.breaker.clear(scanId)
    }
    for (const [scanId, tally] of result.tallies) {
      const scan = result.scans.get(scanId)
      if (!scan || scan.state !== 'running') continue
      if (await this.checkBreaker(scanId, nowMs)) continue
      // The counters as this flush's own increment returned them: the cached scan predates the increments of
      // earlier flushes until the change stream invalidates it, so its hints can be short of the last results.
      this.checkCompletion(counted.get(scanId) ?? cachedCompletionView(scan, tally), nowMs)
    }
  }

  private async checkBreaker(scanId: string, nowMs: number): Promise<boolean> {
    const { breakerMinAttempts, breakerRatio, breakerWindowMs } = this.deps.config
    const tripped = this.breaker.trips(scanId, nowMs, breakerMinAttempts, breakerRatio)
    if (!tripped) return false
    this.breaker.clear(scanId)
    const ratio = Math.round(tripped.ratio * 1000) / 1000
    const details = {
      ratio,
      attempts: tripped.attempts,
      windowMs: breakerWindowMs,
      message: `${Math.round(tripped.ratio * 100)}% of the last ${tripped.attempts} attempts failed`,
    }
    try {
      await this.deps.hooks.pauseScanBySystem(scanId, 'failureRate', details)
      breakerTrips.inc()
      this.deps.log.warn('circuit breaker paused a scan', { scanId, ratio, attempts: tripped.attempts })
    } catch (error) {
      this.deps.log.error('pausing a scan for its failure rate failed', { scanId, err: error })
    }
    this.deps.cache.invalidate(scanId)
    return true
  }

  /**
   * Triggers completion when the hint terminal count reaches the confirmed count, at most every 10 s per scan and
   * round: a trigger of an earlier round (which completed it) never holds back the first trigger of a retry round. A
   * check the interval holds back runs once when it ends, so a trigger that came too early (hints that overestimate)
   * cannot leave the round's last results to the periodic recount.
   */
  private checkCompletion(view: CompletionView, nowMs: number): void {
    if (view.state !== 'running') return
    if (view.schedulingState !== 'done' && view.schedulingState !== 'failed') return
    if (view.terminal < view.confirmed) return
    const last = this.lastCompletionTrigger.get(view.id)
    if (last && last.round === view.round && nowMs - last.at < COMPLETION_TRIGGER_INTERVAL_MS) {
      this.deferCompletion(view.id, view.round, last.at + COMPLETION_TRIGGER_INTERVAL_MS - nowMs)
      return
    }
    this.triggerCompletion(view.id, view.round, nowMs)
  }

  private deferCompletion(scanId: string, round: number, delayMs: number): void {
    if (this.deferredCompletions.has(scanId)) return
    const timer = setTimeout(() => {
      this.deferredCompletions.delete(scanId)
      this.triggerCompletion(scanId, round, this.now().getTime())
    }, delayMs)
    timer.unref()
    this.deferredCompletions.set(scanId, timer)
  }

  private triggerCompletion(scanId: string, round: number, nowMs: number): void {
    this.lastCompletionTrigger.set(scanId, { round, at: nowMs })
    this.deps.hooks.tryCompleteScan(scanId, 'ingestor').then(
      (completed) => {
        if (completed) this.deps.cache.invalidate(scanId)
      },
      (error: unknown) => this.deps.log.error('completion check failed', { scanId, err: error }),
    )
  }

  /**
   * Starts the rate refresh. The window starts empty with the process, so rates an earlier process stored are reset
   * to 0 first; the next flush of a scan that still produces results writes its rate again at once.
   */
  async start(): Promise<void> {
    try {
      const reset = await this.deps.scans.updateMany({ 'stats.ratePerMin': { $gt: 0 } }, { $set: { 'stats.ratePerMin': 0 } })
      if (reset.modifiedCount > 0) this.deps.log.info('reset the rates an earlier process stored', { scans: reset.modifiedCount })
    } catch (error) {
      // Only display values are stale then; ingesting must not wait for it.
      this.deps.log.warn('resetting the rates an earlier process stored failed', { err: error })
    }
    if (this.rateTimer) return
    this.rateTimer = setInterval(() => void this.refreshRates(this.now().getTime()), RATE_REFRESH_INTERVAL_MS)
    this.rateTimer.unref()
  }

  /** Writes the rates that changed without a flush (results stopped) and forgets scans whose rate reached 0. */
  async refreshRates(nowMs: number): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      for (const [scanId, rate] of this.rate.staleRates(nowMs)) {
        try {
          // No updatedAt: only the derived rate changes, and paused scans are recounted when updatedAt moves.
          await this.deps.scans.updateOne({ _id: scanId }, { $set: { 'stats.ratePerMin': rate } })
          this.rate.markStored(scanId, rate)
        } catch (error) {
          this.deps.log.warn('updating the rate of a scan failed', { scanId, err: error })
        }
      }
    } finally {
      this.refreshing = false
    }
  }

  /** Drops the completion checks still waiting for their interval and the rate refresh (the ingestor stops). */
  stop(): void {
    for (const timer of this.deferredCompletions.values()) clearTimeout(timer)
    this.deferredCompletions.clear()
    if (this.rateTimer) clearInterval(this.rateTimer)
    this.rateTimer = null
  }
}
