import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import analysisSchema from '../../../../schemas/messages/analysis.schema.json'
import attemptSchema from '../../../../schemas/messages/attempt.schema.json'
import resultSchema from '../../../../schemas/messages/result.schema.json'

// AMQP message bodies (docs/queue.md §5, schemas/messages/*.json, shared with the Go runtime). Check 6 of §6.2
// validates result and attempt bodies against their closed schemas; the dead-letter consumer validates
// dead-lettered analysis messages. Validators are compiled once.

export type FileRefMessage = { id: string; name: string; size: number; sha256: string; contentType: string }

export interface ScantorErrorMessage {
  type: string
  message: string
  retryable: boolean
  phase: string
  attempt: number
  stack?: string | null
  details?: Record<string, unknown> | null
  at: number
}

export interface TimingsMessage {
  scheduledAt: number
  startedAt: number
  finishedAt: number
  durationMs: number
}

interface ResultOrAttemptBase {
  v: 1
  analysisId: string
  scanId: string
  seq: number
  round: number
  attempt: number
  executionId: string
  workerId: string
  nodeId: string
  config: Record<string, unknown>
  logTail: string
  timings: TimingsMessage
}

export interface ResultMessage extends ResultOrAttemptBase {
  kind: 'result'
  status: 'succeeded' | 'failed'
  result: Record<string, unknown> | null
  error: ScantorErrorMessage | null
  files: FileRefMessage[]
}

export interface AttemptMessage extends ResultOrAttemptBase {
  kind: 'attempt'
  error: ScantorErrorMessage
}

export interface AnalysisMessage {
  v: 1
  analysisId: string
  scanId: string
  seq: number
  round: number
  attempt: number
  config: Record<string, unknown>
  scheduledAt: number
}

const ajv = new Ajv2020({ allErrors: false, strict: false })

const validators = {
  result: ajv.compile<ResultMessage>(resultSchema),
  attempt: ajv.compile<AttemptMessage>(attemptSchema),
  analysis: ajv.compile<AnalysisMessage>(analysisSchema),
}

function firstError(errors: ErrorObject[] | null | undefined): string {
  const error = errors?.[0]
  if (!error) return 'does not match the message schema'
  return `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`.slice(0, 512)
}

export type SchemaCheck<T> = { ok: true; value: T } | { ok: false; error: string }

function check<T>(validate: ValidateFunction<T>, body: unknown): SchemaCheck<T> {
  return validate(body) ? { ok: true, value: body } : { ok: false, error: firstError(validate.errors) }
}

export function checkResultMessage(body: unknown): SchemaCheck<ResultMessage> {
  return check(validators.result, body)
}

export function checkAttemptMessage(body: unknown): SchemaCheck<AttemptMessage> {
  return check(validators.attempt, body)
}

export function checkAnalysisMessage(body: unknown): SchemaCheck<AnalysisMessage> {
  return check(validators.analysis, body)
}
