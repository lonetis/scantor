import type { ScantorErrorDoc } from '../../types/documents'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { WorkerPrincipal } from '../../utils/principal'
import { isoDate } from '../../utils/serialize'
import { recordEvent } from '../nodes/events'
import { tailBytesOf } from '../nodes/logs'
import { raiseScanCondition } from './conditions'
import { countSchedulerRestart } from './scheduler'
import { mergeRuntime } from './worker-runtime'

// POST /api/runtime/errors (docs/api.md §8.8): a worker-level error report. It is stored as the worker's
// `runtime.lastError`, recorded as a `worker.error` event and raises the scan condition `workerErrors`. For the
// scheduler, a `schedule`-phase or retryable error counts as a scheduler restart (docs/runtime.md §11.9).

/** `context.stderrTail` is at most 4 KiB (docs/api.md §8.8); longer tails keep their end. */
export const STDERR_TAIL_MAX_BYTES = 4096

export interface RuntimeErrorReport {
  fatal: boolean
  error: ScantorErrorDoc
  context?: { stderrTail?: string }
}

export async function recordRuntimeError(principal: WorkerPrincipal, report: RuntimeErrorReport, maxRestarts: number, log: Logger): Promise<{ recorded: true }> {
  const { workers } = useCollections()
  const { worker } = principal
  const now = new Date()
  await workers.updateOne({ _id: worker.id }, [{ $set: { runtime: mergeRuntime({ lastError: report.error }), updatedAt: now } }])
  const apiError = { ...report.error, at: isoDate(report.error.at) }
  await recordEvent({
    type: 'worker.error',
    level: 'warning',
    userId: worker.userId,
    scanId: worker.scanId,
    workerId: worker.id,
    nodeId: worker.nodeId,
    message: `${worker.role} worker reported a ${report.fatal ? 'fatal ' : ''}${report.error.type} error in phase ${report.error.phase}: ${report.error.message}`,
    data: { error: apiError, fatal: report.fatal, ...(report.context?.stderrTail ? { stderrTail: tailBytesOf(report.context.stderrTail, STDERR_TAIL_MAX_BYTES).text } : {}) },
    at: now,
  }, log)
  await raiseScanCondition(
    worker.scanId,
    {
      type: 'workerErrors',
      severity: 'warning',
      reason: report.error.type,
      message: `a ${worker.role} worker reported: ${report.error.message}`.slice(0, 1024),
      details: { workerId: worker.id, error: apiError },
    },
    worker.userId,
    now,
  )
  if (worker.role === 'scheduler' && (report.error.phase === 'schedule' || report.error.retryable)) {
    await countSchedulerRestart(worker.scanId, worker.epoch, report.error, maxRestarts, log)
  }
  return { recorded: true }
}
