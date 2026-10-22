import {
  type AnalysisWrite,
  buildAttemptWrite,
  buildDeadLetterWrite,
  buildFailedWrite,
  buildMinimalFailedWrite,
  buildSucceededWrite,
  type DeathInfo,
  type WriteTarget,
} from './build-document'
import type { AuthenticatedMessage } from './identity'
import { type AnalysisMessage, checkAttemptMessage, checkResultMessage } from './messages'

// Ingest items: one per message that passed the identity checks. The batch processor decides per item whether its
// scan accepts it (§6.2 checks 4–5); `prepare` then builds the guarded upsert, applying the schema and size checks
// (check 6, ING-4) that turn an authenticated but unusable message into a minimal failed document.

export type IngestKind = 'result' | 'attempt' | 'dead'

export interface IngestItem {
  scanId: string
  seq: number
  round: number
  attempt: number
  /** the `kind` label of scantor_ingest_messages_total */
  kind: IngestKind
  /** the execution id as sent (stored on minimal documents only when it is a uuid) */
  executionId: unknown
  prepare(target: WriteTarget): AnalysisWrite
}

/** A result or attempt message from scantor.results.ingest. */
export function messageItem(message: AuthenticatedMessage, limits: { maxResultBytes: number }): IngestItem {
  const executionId = message.body.executionId
  return {
    scanId: message.scanId,
    seq: message.seq,
    round: message.round,
    attempt: message.attempt,
    kind: message.kind,
    executionId,
    prepare(target) {
      if (message.kind === 'attempt') {
        const checked = checkAttemptMessage(message.body)
        if (!checked.ok) return buildMinimalFailedWrite(target, { reason: `invalid result message: ${checked.error}`, executionId })
        return buildAttemptWrite(checked.value, target)
      }
      const checked = checkResultMessage(message.body)
      if (!checked.ok) return buildMinimalFailedWrite(target, { reason: `invalid result message: ${checked.error}`, executionId })
      const result = checked.value
      if (result.status === 'failed') return buildFailedWrite(result, target)
      const size = Buffer.byteLength(JSON.stringify(result.result))
      if (size > limits.maxResultBytes) {
        return buildMinimalFailedWrite(target, {
          reason: `the result is ${size} bytes, above SCANTOR_MAX_RESULT_BYTES (${limits.maxResultBytes} bytes)`,
          type: 'validation',
          executionId,
        })
      }
      return buildSucceededWrite(result, target)
    },
  }
}

/** A dead-lettered analysis message of scan queue `scantor.scan.<scanId>` (docs/queue.md §7). */
export function deadLetterItem(message: AnalysisMessage, death: DeathInfo, deliveryLimit: number): IngestItem {
  return {
    scanId: message.scanId,
    seq: message.seq,
    round: message.round,
    attempt: message.attempt,
    kind: 'dead',
    executionId: undefined,
    prepare: (target) => buildDeadLetterWrite(message, target, death, deliveryLimit),
  }
}
