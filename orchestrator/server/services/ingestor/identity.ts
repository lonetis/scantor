import type { Message } from 'amqplib'

/*
 * Checks 1–3 of docs/queue.md §6.2, run when a delivery arrives on scantor.results.ingest (and re-run by the
 * dead-letter consumer to explain a rejection). The scan identity comes only from the broker-validated AMQP
 * `user_id` (`scan-<scanId>`); the body must agree with it. A message that fails here is unauthenticated or
 * unattributable and is rejected to scantor.dead (security.md ING-1, ING-2).
 */

/** Largest accepted body; the broker's max_message_size is 4 MiB as well. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

const USER_ID = /^scan-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export type RejectReason =
  | 'missingUserId'
  | 'invalidUserId'
  | 'routingKeyMismatch'
  | 'bodyTooLarge'
  | 'invalidUtf8'
  | 'invalidJson'
  | 'notAnObject'
  | 'scanIdMismatch'
  | 'invalidSeq'
  | 'analysisIdMismatch'
  | 'invalidRound'
  | 'invalidAttempt'
  | 'invalidKind'

export type MessageKind = 'result' | 'attempt'

/** A delivery that passed checks 1–3: authenticated, attributable, well-formed JSON. */
export interface AuthenticatedMessage {
  scanId: string
  seq: number
  round: number
  attempt: number
  kind: MessageKind
  /** the parsed body; untrusted beyond the checked fields */
  body: Record<string, unknown>
  bytes: number
}

export type IdentityResult = { ok: true; message: AuthenticatedMessage } | { ok: false; reason: RejectReason }

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The scan id of an AMQP `user_id` of the form `scan-<uuid>`, or null. */
export function scanIdOfUserId(userId: unknown): string | null {
  if (typeof userId !== 'string') return null
  return USER_ID.exec(userId)?.[1] ?? null
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** A valid seq: an integer 0 ≤ seq < 2^53. */
export function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function fail(reason: RejectReason): IdentityResult {
  return { ok: false, reason }
}

/** Parses a body as a UTF-8 JSON object of at most MAX_BODY_BYTES. */
export function parseJsonObject(content: Buffer): { ok: true; body: Record<string, unknown> } | { ok: false; reason: RejectReason } {
  if (content.length > MAX_BODY_BYTES) return { ok: false, reason: 'bodyTooLarge' }
  let text: string
  try {
    text = utf8.decode(content)
  } catch {
    return { ok: false, reason: 'invalidUtf8' }
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'invalidJson' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'notAnObject' }
  return { ok: true, body: body as Record<string, unknown> }
}

/** Checks 1–3 of docs/queue.md §6.2 for a delivery from scantor.results.ingest. */
export function authenticateResultMessage(message: Pick<Message, 'content' | 'fields' | 'properties'>): IdentityResult {
  const userId: unknown = message.properties.userId
  if (userId === undefined || userId === null || userId === '') return fail('missingUserId')
  const scanId = scanIdOfUserId(userId)
  if (!scanId) return fail('invalidUserId')
  if (message.fields.routingKey !== scanId) return fail('routingKeyMismatch')

  const parsed = parseJsonObject(message.content)
  if (!parsed.ok) return fail(parsed.reason)
  const body = parsed.body
  if (body.scanId !== scanId) return fail('scanIdMismatch')
  if (!isSeq(body.seq)) return fail('invalidSeq')
  if (body.analysisId !== `${scanId}-${body.seq}`) return fail('analysisIdMismatch')
  if (!isPositiveInteger(body.round)) return fail('invalidRound')
  if (!isPositiveInteger(body.attempt)) return fail('invalidAttempt')
  if (body.kind !== 'result' && body.kind !== 'attempt') return fail('invalidKind')
  return {
    ok: true,
    message: { scanId, seq: body.seq, round: body.round, attempt: body.attempt, kind: body.kind, body, bytes: message.content.length },
  }
}
