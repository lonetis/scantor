import { isDeepStrictEqual } from 'node:util'
import type { Collection } from 'mongodb'
import type { ConditionType, Severity } from '#shared/utils/enums'
import type { ConditionDoc, ScanDoc } from '../../types/documents'
import { useCollections } from '../../utils/mongo'
import { type EventInput, writeEvent } from './events'

/*
 * Scan conditions (docs/data-model.md §4.5.4): bounded (≤ 16), at most one entry per type, removed when cleared.
 * Writers compare against the scan they loaded and write only real changes, so reconciler ticks never rewrite
 * unchanged conditions (and never wake change streams for nothing). Raising and clearing write the events
 * `scan.conditionRaised` / `scan.conditionCleared`.
 */

export const MAX_CONDITIONS = 16

/** The fixed severity of every condition type. */
export const CONDITION_SEVERITY: Record<ConditionType, Severity> = {
  workersPending: 'warning',
  crashLoop: 'error',
  imagePullFailed: 'error',
  workerErrors: 'warning',
  schedulerRestarting: 'warning',
  schedulingFailed: 'error',
  topologyFailed: 'error',
  brokerAlarm: 'error',
  breakerTripped: 'error',
  stalled: 'warning',
  clockSkew: 'warning',
}

export interface ConditionInput {
  type: ConditionType
  reason: string
  message: string
  details?: Record<string, unknown>
}

type ScanRef = Pick<ScanDoc, '_id' | 'userId' | 'conditions'>

function sameCondition(current: ConditionDoc, next: ConditionInput): boolean {
  return current.reason === next.reason && current.message === next.message && isDeepStrictEqual(current.details ?? null, next.details ?? null)
}

function conditionEvent(scan: Pick<ScanDoc, '_id' | 'userId'>, kind: 'Raised' | 'Cleared', type: ConditionType, reason: string, message: string): EventInput {
  const severity = CONDITION_SEVERITY[type]
  return {
    type: `scan.condition${kind}`,
    level: kind === 'Cleared' ? 'info' : severity,
    userId: scan.userId,
    scanId: scan._id,
    message: kind === 'Cleared' ? `condition ${type} cleared` : `condition ${type}: ${message}`,
    data: { type, reason },
  }
}

/**
 * Raises or updates a condition. `scan` is the caller's view of the document; nothing is written when the
 * condition is already present with the same reason, message and details. Returns true when it was newly raised.
 */
export async function setCondition(
  scan: ScanRef,
  input: ConditionInput,
  now: Date = new Date(),
  scans: Collection<ScanDoc> = useCollections().scans,
): Promise<boolean> {
  const current = scan.conditions.find((condition) => condition.type === input.type)
  if (current && sameCondition(current, input)) return false
  const severity = CONDITION_SEVERITY[input.type]
  const updated = await scans.updateOne(
    { _id: scan._id, 'conditions.type': input.type },
    {
      $set: {
        'conditions.$.severity': severity,
        'conditions.$.reason': input.reason,
        'conditions.$.message': input.message,
        'conditions.$.details': input.details ?? null,
        'conditions.$.updatedAt': now,
      },
    },
  )
  if (updated.matchedCount > 0) return false
  const condition: ConditionDoc = { type: input.type, severity, reason: input.reason, message: input.message, since: now, updatedAt: now }
  if (input.details !== undefined) condition.details = input.details
  const pushed = await scans.updateOne(
    { _id: scan._id, 'conditions.type': { $ne: input.type }, [`conditions.${MAX_CONDITIONS - 1}`]: { $exists: false } },
    { $push: { conditions: condition } },
  )
  if (pushed.modifiedCount === 0) return false
  await writeEvent(conditionEvent(scan, 'Raised', input.type, input.reason, input.message))
  return true
}

/** Removes a condition when the caller's view has it. Returns true when it was removed. */
export async function clearCondition(scan: ScanRef, type: ConditionType, scans: Collection<ScanDoc> = useCollections().scans): Promise<boolean> {
  if (!scan.conditions.some((condition) => condition.type === type)) return false
  const result = await scans.updateOne({ _id: scan._id, 'conditions.type': type }, { $pull: { conditions: { type } } })
  if (result.modifiedCount === 0) return false
  await writeEvent(conditionEvent(scan, 'Cleared', type, '', ''))
  return true
}

/** Sets the condition when `input` is given, clears it when null. */
export async function reconcileCondition(
  scan: ScanRef,
  type: ConditionType,
  input: Omit<ConditionInput, 'type'> | null,
  now: Date = new Date(),
  scans: Collection<ScanDoc> = useCollections().scans,
): Promise<void> {
  if (input) await setCondition(scan, { type, ...input }, now, scans)
  else await clearCondition(scan, type, scans)
}

/** Conditions sorted by severity (error first), then by type: the order of listScanConditions and the UI. */
export function sortConditions<T extends { severity: Severity; type: string }>(conditions: readonly T[]): T[] {
  const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
  return [...conditions].sort((a, b) => rank[a.severity] - rank[b.severity] || a.type.localeCompare(b.type))
}
