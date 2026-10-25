import type { JobDoc, ScanDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { scanAmqpUser, scanQueueName } from '../../utils/amqp'
import { cancelActiveJobs, FatalJobError, type JobContext, JobDeferredError, type JobKindDefinition } from '../../utils/jobs'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { RABBITMQ_VHOST, useRabbitmqManagement } from '../../utils/rabbitmq-management'
import { deleteObject, deletePrefix, isS3NotFound } from '../../utils/s3'
import { notifyAssignmentsChanged } from '../nodes/assignments'

/*
 * Scan deletion (docs/architecture.md §11.3 "delete", docs/queue.md §6.3, §8): the `scanDelete` job (reconciler
 * component, concurrency 2) with the resumable cursor `{phase, afterSeq, settleUntil}`. Two slots bound the load that
 * mass deletions put on MongoDB and S3; a job holds its slot only while it works, so small deletions pass quickly:
 *
 *   broker    delete the RabbitMQ user scan-<id>, then the queue (404 counts as done)
 *   workers   delete the worker documents (their nodes drop the containers)
 *   analyses  delete analyses in 10 000-document batches by seq; after DELETE_SLICE_MS of batches the job defers
 *             itself (with its cursor) while other scanDelete jobs wait, so a large scan does not hold a slot for
 *             minutes ahead of them
 *   files     delete the S3 prefix files/<scanId>/
 *   exports   delete the scan's exports (S3 objects and documents)
 *   events    delete the scan's events
 *   settle    wait 2 × SCANTOR_INGEST_FLUSH_INTERVAL + 10 s after the broker phase; the job defers itself
 *             (JobDeferredError) instead of sleeping, so the wait holds no job slot
 *   sweep     a final analyses.deleteMany({scanId}) for results ingested before the cache saw `deleting`
 *   finish    state `deleted`, purgeAfter = now + SCANTOR_TOMBSTONE_DAYS (a minimal tombstone)
 *
 * The helpers are shared with the userPurge step that deletes all scans of a user (./purge.ts).
 */

export const ANALYSES_DELETE_BATCH = 10_000
/** How long a scanDelete job deletes analyses before it gives its slot to waiting deletions. */
export const DELETE_SLICE_MS = 10_000
export const DELETE_PHASES = ['broker', 'workers', 'analyses', 'files', 'exports', 'events', 'settle', 'sweep', 'finish'] as const
export type DeletePhase = (typeof DELETE_PHASES)[number]

export function settleDelayMs(config: Pick<Config, 'ingestFlushIntervalMs'>): number {
  return 2 * config.ingestFlushIntervalMs + 10_000
}

/** Deletes the per-scan RabbitMQ user first (kill switch), then the queue (docs/queue.md §3.5). */
export async function deleteScanBrokerObjects(scanId: string): Promise<void> {
  const management = useRabbitmqManagement()
  await management.deleteUser(scanAmqpUser(scanId))
  await management.deleteQueue(RABBITMQ_VHOST, scanQueueName(scanId))
}

/** Deletes the worker documents of a scan and wakes the long-polls of the nodes that still ran some of them. */
export async function deleteScanWorkers(scanId: string): Promise<void> {
  const { workers } = useCollections()
  const nodeIds = (await workers.distinct('nodeId', { scanId, state: { $nin: ['stopped', 'lost'] } })).filter((id): id is string => typeof id === 'string')
  await workers.deleteMany({ scanId })
  for (const nodeId of nodeIds) await notifyAssignmentsChanged(nodeId)
}

/**
 * Deletes analyses in batches of `batch` by seq, starting after `afterSeq`; `onBatch` persists progress (`more`: another
 * batch follows).
 */
export async function deleteScanAnalyses(
  scanId: string,
  afterSeq: number,
  onBatch: (afterSeq: number, deleted: number, more: boolean) => Promise<void>,
  signal?: AbortSignal,
  batch = ANALYSES_DELETE_BATCH,
): Promise<void> {
  const { analyses } = useCollections()
  let cursor = afterSeq
  for (;;) {
    signal?.throwIfAborted()
    const boundary = await analyses
      .find({ scanId, seq: { $gt: cursor } }, { projection: { _id: 0, seq: 1 } })
      .sort({ seq: 1 })
      .skip(batch - 1)
      .limit(1)
      .next()
    if (!boundary) {
      const result = await analyses.deleteMany({ scanId, seq: { $gt: cursor } })
      await onBatch(cursor, result.deletedCount, false)
      return
    }
    const result = await analyses.deleteMany({ scanId, seq: { $gt: cursor, $lte: boundary.seq } })
    cursor = boundary.seq
    await onBatch(cursor, result.deletedCount, true)
  }
}

/** Deletes the exports of a scan: their S3 objects, active export jobs and documents. */
export async function deleteScanExports(scanId: string, log: Logger): Promise<void> {
  const { exports } = useCollections()
  for (const doc of await exports.find({ scanId }, { projection: { _id: 1, key: 1 } }).toArray()) {
    await cancelActiveJobs('export', doc._id)
    try {
      await deleteObject(doc.key)
    } catch (error) {
      if (!isS3NotFound(error)) throw error
      log.debug('export object already gone', { exportId: doc._id })
    }
  }
  await exports.deleteMany({ scanId })
}

/** The tombstone (docs/data-model.md §4.5): configs, secrets and references dropped; purged by TTL. */
export function tombstoneUpdate(now: Date, tombstoneDays: number) {
  return {
    $set: {
      state: 'deleted' as const,
      deletedAt: now,
      updatedAt: now,
      purgeAfter: new Date(now.getTime() + tombstoneDays * 86_400_000),
      taskConfig: {},
      scanConfig: {},
      secrets: { taskConfig: {}, scanConfig: {} },
      uploadIds: [],
      conditions: [],
      'scheduling.resolved': {},
    },
  }
}

interface DeleteCursor {
  phase: DeletePhase
  afterSeq: number
  settleUntil: number | null
}

function readCursor(job: JobDoc): DeleteCursor {
  const phase = (DELETE_PHASES as readonly string[]).includes(job.cursor.phase as string) ? (job.cursor.phase as DeletePhase) : 'broker'
  return {
    phase,
    afterSeq: typeof job.cursor.afterSeq === 'number' ? job.cursor.afterSeq : -1,
    settleUntil: typeof job.cursor.settleUntil === 'number' ? job.cursor.settleUntil : null,
  }
}

/**
 * Defers the job (cursor saved) once it worked for DELETE_SLICE_MS while another scanDelete job is due: the runner
 * claims due jobs in `notBefore` order, so the waiting ones run first and this one continues after them.
 */
export async function yieldToWaitingDeletes(job: JobDoc, startedAt: number, now = Date.now()): Promise<void> {
  if (now - startedAt < DELETE_SLICE_MS) return
  const waiting = await useCollections().jobs.countDocuments(
    { state: 'queued', kind: 'scanDelete', notBefore: { $lte: new Date(now) }, _id: { $ne: job._id } },
    { limit: 1 },
  )
  if (waiting > 0) throw new JobDeferredError(new Date(now), 'giving the slot to waiting scan deletions')
}

async function runPhase(phase: DeletePhase, scan: ScanDoc, cursor: DeleteCursor, ctx: JobContext, startedAt: number): Promise<void> {
  const { scans, analyses, events } = useCollections()
  switch (phase) {
    case 'broker':
      await deleteScanBrokerObjects(scan._id)
      cursor.settleUntil = Date.now() + settleDelayMs(ctx.config)
      return
    case 'workers':
      await deleteScanWorkers(scan._id)
      return
    case 'analyses': {
      // A job that deferred itself between batches continues its count.
      let deleted = typeof ctx.job.progress.done === 'number' ? ctx.job.progress.done : 0
      await deleteScanAnalyses(
        scan._id,
        cursor.afterSeq,
        async (afterSeq, count, more) => {
          deleted += count
          cursor.afterSeq = afterSeq
          await ctx.saveCursor({ ...cursor }, { done: deleted })
          if (more) await yieldToWaitingDeletes(ctx.job, startedAt)
        },
        ctx.signal,
      )
      return
    }
    case 'files':
      await deletePrefix(`files/${scan._id}/`)
      return
    case 'exports':
      await deleteScanExports(scan._id, ctx.log)
      return
    case 'events':
      await events.deleteMany({ scanId: scan._id })
      return
    case 'settle': {
      // The wait holds no job slot: the job comes back once the settle delay is over (the cursor is saved at 'settle').
      const until = cursor.settleUntil ?? 0
      if (until > Date.now()) throw new JobDeferredError(new Date(until), 'the scan-delete settle delay')
      return
    }
    case 'sweep':
      await analyses.deleteMany({ scanId: scan._id })
      return
    case 'finish':
      await scans.updateOne({ _id: scan._id, state: 'deleting' }, tombstoneUpdate(new Date(), ctx.config.tombstoneDays))
      return
  }
}

export const scanDeleteJobKind: JobKindDefinition = {
  component: 'reconciler',
  concurrency: 2,
  maxAttempts: 10,
  async handler(job: JobDoc, ctx: JobContext) {
    if (job.subject.kind !== 'scan') throw new FatalJobError('invalidSubject', `scanDelete needs a scan subject, got ${job.subject.kind}`)
    const scan = await useCollections().scans.findOne({ _id: job.subject.id })
    if (!scan || scan.state === 'deleted') return
    if (scan.state !== 'deleting') throw new FatalJobError('invalidState', `scan ${scan._id} is ${scan.state}, not deleting`)
    await cancelActiveJobs('scanRetryFailed', scan._id)
    const startedAt = Date.now()
    const cursor = readCursor(job)
    for (let index = DELETE_PHASES.indexOf(cursor.phase); index < DELETE_PHASES.length; index++) {
      ctx.signal.throwIfAborted()
      cursor.phase = DELETE_PHASES[index]!
      await ctx.saveCursor({ ...cursor })
      await runPhase(cursor.phase, scan, cursor, ctx, startedAt)
    }
    ctx.log.info('scan deleted', { scanId: scan._id })
  },
}
