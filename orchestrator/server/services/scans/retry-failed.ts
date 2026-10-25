import type { ConfirmChannel } from 'amqplib'
import type { AnalysisDoc, JobDoc, ScanDoc } from '../../types/documents'
import { scanQueueName, useAmqp } from '../../utils/amqp'
import type { Config } from '../../utils/config'
import { FatalJobError, type JobContext, type JobKindDefinition } from '../../utils/jobs'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { RABBITMQ_VHOST, useRabbitmqManagement } from '../../utils/rabbitmq-management'
import { scantorVersion } from '../../utils/version'
import { getScanInflight } from '../inflight'
import { recordAnalysesCompleted } from '../metrics/catalogue'
import { recountScan, tryCompleteScan } from './completion'
import { settleDelayMs } from './delete'
import { writeEvent } from './events'
import { publishAnalyses, QueueReadyReader } from './publisher'

/*
 * The `scanRetryFailed` job (reconciler component, concurrency 2; docs/queue.md §8 "retry-failed publisher",
 * docs/data-model.md §6.3). `params = {round: R + 1, materialize, cancelledAt?}`, cursor `{phase, afterSeq}`:
 *
 *   materialize  only for scans that were cancelled: first let round R settle (settleEarlierRounds), then insert
 *                `cancelled` documents (no config) for missing seqs below scheduling.confirmed, so never-run
 *                analyses are visible and countable
 *   reset        batches of 1000 by seq: failed and lost analyses with a stored config → pending, round R + 1,
 *                attempt 0; then a recount and the event scan.retryFailed
 *   publish      wait for the scan queue, then publish the pending configs of round R + 1 with the nack-and-wait
 *                loop, keeping at most half of the queue like the scheduler (publisher.ts, docs/runtime.md §11.4);
 *                the cursor advances after each fully confirmed batch
 *   finish       scheduling returns to `failed` (scheduling.error set) or `done`; recount; completion check
 *
 * A job that fails for good still runs `finish`, so the scan never stays in `retrying`.
 */

export const RETRY_BATCH = 1000
export const RETRY_PHASES = ['materialize', 'reset', 'publish', 'finish'] as const
export type RetryPhase = (typeof RETRY_PHASES)[number]
const QUEUE_POLL_MS = 5000
/** How long the job tolerates a scan that has not entered `retrying` yet (the API writes the scan after the job). */
const SCAN_SETTLE_MS = 60_000
/** How often a retry of a cancelled scan looks at the analyses its runners report in flight. */
export const INFLIGHT_POLL_MS = 1000

const LOST_OR_FAILED = ['failed', 'lost'] as const

interface RetryCursor {
  phase: RetryPhase
  afterSeq: number
}

function readCursor(job: JobDoc, materialize: boolean): RetryCursor {
  const phase = (RETRY_PHASES as readonly string[]).includes(job.cursor.phase as string) ? (job.cursor.phase as RetryPhase) : materialize ? 'materialize' : 'reset'
  return { phase, afterSeq: typeof job.cursor.afterSeq === 'number' ? job.cursor.afterSeq : -1 }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface SettleOptions {
  /** the round of the retry (R + 1) */
  round: number
  /** when the scan was cancelled (ms) */
  cancelledAt: number
  /** the ingestor's settle delay (settleDelayMs) */
  settleMs: number
  signal: AbortSignal
  /** rounds of the analyses the scan's runners report in flight (state polls, services/inflight.ts) */
  inflightRounds: () => number[]
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Waits until round R of a cancelled scan can no longer change an analysis (docs/queue.md §8 "retry-failed
 * publisher" step 1). The retry makes the scan `running` again, so the topology loop recreates the scan user with
 * the same password: a runner whose connection the cancel's kill switch closed reconnects instead of being refused,
 * finishes the analyses it was running and publishes their round-R results. Materializing or resetting before
 * those are written would record such an analysis as `cancelled` (never run) and then let its late failure turn it
 * into a round-R failure that this retry never runs. So the job waits until no runner has reported an analysis of an
 * earlier round (a slot reports one until its results are confirmed by the broker) for the ingestor's settle delay,
 * and at least that long after the cancel, for results already on their way to the ingestor.
 */
export async function settleEarlierRounds(options: SettleOptions): Promise<void> {
  const now = options.now ?? Date.now
  const wait = options.sleep ?? sleep
  let quietSince = options.cancelledAt
  for (;;) {
    options.signal.throwIfAborted()
    const at = now()
    if (options.inflightRounds().some((round) => round < options.round)) quietSince = at
    const remaining = quietSince + options.settleMs - at
    if (remaining <= 0) return
    await wait(Math.min(remaining, INFLIGHT_POLL_MS), options.signal)
  }
}

function cancelledAtOf(job: JobDoc): number {
  const value = job.params.cancelledAt
  const at = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(at) ? at : job.createdAt.getTime()
}

/** Missing seqs in (afterSeq, afterSeq + batch] below `limit`, given the sorted seqs that exist. */
export function missingSeqs(existing: readonly number[], from: number, to: number): number[] {
  const present = new Set(existing)
  const missing: number[] = []
  for (let seq = from; seq < to; seq++) if (!present.has(seq)) missing.push(seq)
  return missing
}

async function materialize(scan: ScanDoc, round: number, cursor: RetryCursor, ctx: JobContext): Promise<void> {
  const { analyses } = useCollections()
  const confirmed = scan.scheduling.confirmed
  while (cursor.afterSeq + 1 < confirmed) {
    ctx.signal.throwIfAborted()
    const from = cursor.afterSeq + 1
    const to = Math.min(confirmed, from + RETRY_BATCH)
    const existing = await analyses
      .find({ scanId: scan._id, seq: { $gte: from, $lt: to } }, { projection: { _id: 0, seq: 1 } })
      .map((doc) => doc.seq)
      .toArray()
    const now = new Date()
    const docs: AnalysisDoc[] = missingSeqs(existing, from, to).map((seq) => ({
      _id: `${scan._id}-${seq}`,
      scanId: scan._id,
      userId: scan.userId,
      seq,
      round: round - 1,
      status: 'cancelled',
      attempt: 0,
      attempts: [],
      files: [],
      createdAt: now,
      updatedAt: now,
    }))
    if (docs.length > 0) {
      const inserted = await analyses.insertMany(docs, { ordered: false }).then(
        (result) => result.insertedCount,
        (error: unknown) => {
          // A result that arrived meanwhile already created the document (E11000): keep it.
          if ((error as { code?: number }).code !== 11000 && !isOnlyDuplicates(error)) throw error
          return (error as { insertedCount?: number }).insertedCount ?? 0
        },
      )
      recordAnalysesCompleted('cancelled', inserted)
    }
    cursor.afterSeq = to - 1
    await ctx.saveCursor({ ...cursor })
  }
}

function isOnlyDuplicates(error: unknown): boolean {
  const writeErrors = (error as { writeErrors?: { code?: number }[] | { code?: number } }).writeErrors
  const list = Array.isArray(writeErrors) ? writeErrors : writeErrors ? [writeErrors] : []
  return list.length > 0 && list.every((entry) => entry.code === 11000)
}

async function reset(scan: ScanDoc, round: number, cursor: RetryCursor, ctx: JobContext): Promise<number> {
  const { analyses } = useCollections()
  const filter = { scanId: scan._id, status: { $in: [...LOST_OR_FAILED] }, round: { $lte: round - 1 }, config: { $exists: true } }
  let total = typeof ctx.job.progress.total === 'number' ? ctx.job.progress.total : 0
  for (;;) {
    ctx.signal.throwIfAborted()
    const boundary = await analyses
      .find({ ...filter, seq: { $gt: cursor.afterSeq } }, { projection: { _id: 0, seq: 1 } })
      .sort({ seq: 1 })
      .skip(RETRY_BATCH - 1)
      .limit(1)
      .next()
    const seqFilter = boundary ? { $gt: cursor.afterSeq, $lte: boundary.seq } : { $gt: cursor.afterSeq }
    const result = await analyses.updateMany({ ...filter, seq: seqFilter }, { $set: { status: 'pending', round, attempt: 0, updatedAt: new Date() } })
    total += result.modifiedCount
    if (boundary) cursor.afterSeq = boundary.seq
    await ctx.saveCursor({ ...cursor }, { done: 0, total })
    if (!boundary) break
  }
  return total
}

async function waitForQueue(scanId: string, signal: AbortSignal, log: Logger): Promise<void> {
  const management = useRabbitmqManagement()
  for (;;) {
    signal.throwIfAborted()
    if (await management.getQueue(RABBITMQ_VHOST, scanQueueName(scanId))) return
    log.debug('waiting for the scan queue', { scanId })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, QUEUE_POLL_MS)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      }, { once: true })
    })
  }
}

async function publish(scan: ScanDoc, round: number, cursor: RetryCursor, ctx: JobContext): Promise<void> {
  const { analyses } = useCollections()
  await waitForQueue(scan._id, ctx.signal, ctx.log)
  const connection = await useAmqp('reconciler')
  const channel: ConfirmChannel = await connection.createConfirmChannel()
  channel.on('error', (error: Error) => ctx.log.warn('retry-failed publish channel error', { scanId: scan._id, err: error }))
  const ready = new QueueReadyReader(connection, scanQueueName(scan._id), ctx.log)
  let published = typeof ctx.job.progress.done === 'number' ? ctx.job.progress.done : 0
  try {
    for (;;) {
      ctx.signal.throwIfAborted()
      const batch = await analyses
        .find({ scanId: scan._id, status: 'pending', round, seq: { $gt: cursor.afterSeq } }, { projection: { _id: 0, seq: 1, config: 1 } })
        .sort({ seq: 1 })
        .limit(RETRY_BATCH)
        .toArray()
      if (batch.length === 0) return
      await publishAnalyses(
        channel,
        batch.map((doc) => ({ seq: doc.seq, config: doc.config ?? {} })),
        {
          scanId: scan._id,
          round,
          userId: ctx.config.rabbitmqUser,
          appId: `scantor-orchestrator/${scantorVersion}`,
          signal: ctx.signal,
          waitForQueue: () => waitForQueue(scan._id, ctx.signal, ctx.log),
          share: { maxLength: ctx.config.scanQueueMaxReady, readReady: () => ready.read() },
        },
      )
      published += batch.length
      cursor.afterSeq = batch.at(-1)!.seq
      await ctx.saveCursor({ ...cursor }, { done: published })
    }
  } finally {
    await ready.close()
    await channel.close().catch((error: unknown) => ctx.log.debug('closing the publish channel failed', { err: error }))
  }
}

/** Ends a retry: scheduling back to `failed`/`done`, recount, completion check. Idempotent. */
export async function finishRetry(scanId: string, round: number, log: Logger): Promise<void> {
  const { scans } = useCollections()
  const scan = await scans.findOne({ _id: scanId }, { projection: { scheduling: 1, round: 1 } })
  if (!scan) return
  await scans.updateOne(
    { _id: scanId, round, 'scheduling.state': 'retrying' },
    { $set: { 'scheduling.state': scan.scheduling.error ? 'failed' : 'done', updatedAt: new Date() } },
  )
  await recountScan(scanId)
  const completed = await tryCompleteScan(scanId, 'retryFailed')
  log.info('retry of failed analyses finished', { scanId, round, completed })
}

async function loadRetryingScan(job: JobDoc, round: number): Promise<ScanDoc> {
  const scan = await useCollections().scans.findOne({ _id: job.subject.id })
  if (!scan) throw new FatalJobError('scanGone', `scan ${job.subject.id} no longer exists`)
  if (scan.round === round && scan.scheduling.state === 'retrying') return scan
  if (Date.now() - job.createdAt.getTime() < SCAN_SETTLE_MS && scan.round < round) {
    throw new Error(`scan ${scan._id} has not entered round ${round} yet`)
  }
  throw new FatalJobError('notRetrying', `scan ${scan._id} is not retrying round ${round} (round ${scan.round}, scheduling ${scan.scheduling.state})`)
}

function roundOf(job: JobDoc): number {
  const round = job.params.round
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 2) throw new FatalJobError('invalidParams', 'scanRetryFailed needs params.round ≥ 2')
  return round
}

export const scanRetryFailedJobKind: JobKindDefinition = {
  component: 'reconciler',
  concurrency: 2,
  maxAttempts: 10,
  backoff: { initialMs: 5000, maxMs: 120_000 },
  async handler(job: JobDoc, ctx: JobContext) {
    if (job.subject.kind !== 'scan') throw new FatalJobError('invalidSubject', `scanRetryFailed needs a scan subject, got ${job.subject.kind}`)
    const round = roundOf(job)
    const scan = await loadRetryingScan(job, round)
    const cursor = readCursor(job, job.params.materialize === true)
    for (let index = RETRY_PHASES.indexOf(cursor.phase); index < RETRY_PHASES.length; index++) {
      ctx.signal.throwIfAborted()
      const phase = RETRY_PHASES[index]!
      if (phase !== cursor.phase) {
        cursor.phase = phase
        cursor.afterSeq = -1
        await ctx.saveCursor({ ...cursor })
      }
      switch (phase) {
        case 'materialize':
          if (job.params.materialize === true) {
            await settleEarlierRounds({
              round,
              cancelledAt: cancelledAtOf(job),
              settleMs: settleDelayMs(ctx.config),
              signal: ctx.signal,
              inflightRounds: () => getScanInflight(scan._id).items.map((item) => item.round),
            })
            await materialize(scan, round, cursor, ctx)
          }
          break
        case 'reset': {
          const count = await reset(scan, round, cursor, ctx)
          await recountScan(scan._id)
          await writeEvent({
            type: 'scan.retryFailed',
            level: 'info',
            userId: scan.userId,
            scanId: scan._id,
            message: `retrying ${count} failed or lost analyses in round ${round}`,
            data: { round, count },
          })
          break
        }
        case 'publish':
          await publish(scan, round, cursor, ctx)
          break
        case 'finish':
          await finishRetry(scan._id, round, ctx.log)
          break
      }
    }
  },
  async onFailed(job: JobDoc, error: { code: string; message: string }, ctx: { log: Logger; config: Config }) {
    const round = job.params.round
    if (typeof round !== 'number' || job.subject.kind !== 'scan') return
    ctx.log.error('retry of failed analyses gave up; finishing the round', { scanId: job.subject.id, round, error: error.message })
    await finishRetry(job.subject.id, round, ctx.log)
  },
}
