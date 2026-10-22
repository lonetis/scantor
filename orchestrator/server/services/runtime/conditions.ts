import type { Document } from 'mongodb'
import type { ConditionType, Severity } from '#shared/utils/enums'
import type { ConditionDoc } from '../../types/documents'
import { useCollections } from '../../utils/mongo'
import { recordEvent } from '../nodes/events'

// Scan conditions raised from node and runtime reports (docs/data-model.md §4.5.4): `crashLoop` and
// `imagePullFailed` (node status), `workerErrors` and `schedulingFailed` (runtime reports); the reconciler clears
// crashLoop and workerErrors by their own rules. At most one entry per type and at most 16 entries per scan.
// Raising keeps `since` of an existing entry and updates the rest in one atomic pipeline update;
// `scan.conditionRaised` is recorded only when the type was not active before.

export const MAX_CONDITIONS = 16

export interface ConditionInput {
  type: ConditionType
  severity: Severity
  reason: string
  message: string
  details?: Record<string, unknown>
}

/** The pipeline update that replaces the entry of `type` (keeping its `since`) and caps the list. */
export function raiseConditionPipeline(input: ConditionInput, now: Date): Document[] {
  const existing = { $first: { $filter: { input: { $ifNull: ['$conditions', []] }, cond: { $eq: ['$$this.type', input.type] } } } }
  // Report texts may start with "$"; $literal keeps them from being read as field paths.
  const entry: Record<string, unknown> = {
    type: input.type,
    severity: input.severity,
    reason: { $literal: input.reason },
    message: { $literal: input.message },
    since: { $ifNull: ['$$existing.since', now] },
    updatedAt: now,
  }
  if (input.details !== undefined) entry.details = { $literal: input.details }
  return [
    {
      $set: {
        conditions: {
          $let: {
            vars: { existing },
            in: {
              $slice: [
                {
                  $concatArrays: [
                    { $filter: { input: { $ifNull: ['$conditions', []] }, cond: { $ne: ['$$this.type', input.type] } } },
                    [entry],
                  ],
                },
                -MAX_CONDITIONS,
              ],
            },
          },
        },
        updatedAt: now,
      },
    },
  ]
}

/** Raises (or refreshes) a condition on a scan. Returns true when it was newly raised. */
export async function raiseScanCondition(scanId: string, input: ConditionInput, userId: string | null, now = new Date()): Promise<boolean> {
  const { scans } = useCollections()
  const before = await scans.findOneAndUpdate({ _id: scanId }, raiseConditionPipeline(input, now), {
    returnDocument: 'before',
    projection: { conditions: 1 },
  })
  if (!before) return false
  const wasActive = (before.conditions ?? []).some((condition: ConditionDoc) => condition.type === input.type)
  if (!wasActive) {
    await recordEvent({
      type: 'scan.conditionRaised',
      level: input.severity === 'info' ? 'info' : input.severity === 'warning' ? 'warning' : 'error',
      userId,
      scanId,
      message: `condition ${input.type}: ${input.message}`,
      data: { type: input.type, reason: input.reason },
      at: now,
    })
  }
  return !wasActive
}

/**
 * Clears a condition. `match` narrows which entry may be cleared (for example only the `clockSkew` raised for one
 * node). Returns true when an entry was removed.
 */
export async function clearScanCondition(
  scanId: string,
  type: ConditionType,
  userId: string | null,
  match: Record<string, unknown> = {},
  now = new Date(),
): Promise<boolean> {
  const { scans } = useCollections()
  const elementMatch: Record<string, unknown> = { type }
  for (const [key, value] of Object.entries(match)) elementMatch[`details.${key}`] = value
  const result = await scans.updateOne(
    { _id: scanId, conditions: { $elemMatch: elementMatch } },
    { $pull: { conditions: elementMatch as never }, $set: { updatedAt: now } },
  )
  if (result.modifiedCount === 0) return false
  await recordEvent({ type: 'scan.conditionCleared', level: 'info', userId, scanId, message: `condition ${type} cleared`, data: { type, reason: 'cleared' }, at: now })
  return true
}
