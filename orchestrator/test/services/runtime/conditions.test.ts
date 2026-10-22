import { describe, expect, it } from 'vitest'
import { MAX_CONDITIONS, raiseConditionPipeline } from '../../../server/services/runtime/conditions'
import { T0 } from '../nodes/helpers'

// Scan conditions raised from node and runtime reports (docs/data-model.md §4.5.4): one atomic pipeline update that
// replaces the entry of its type (keeping `since`), caps the list at 16 and never evaluates report texts.

describe('raiseConditionPipeline', () => {
  it('replaces the entry of the type, keeps since and caps the list', () => {
    const [stage] = raiseConditionPipeline(
      { type: 'crashLoop', severity: 'error', reason: 'exitCode', message: '$fieldPath looking text', details: { logTail: '$$ROOT' } },
      T0,
    )
    const set = (stage as { $set: Record<string, unknown> }).$set
    expect(set.updatedAt).toEqual(T0)
    const conditions = set.conditions as { $let: { vars: Record<string, unknown>; in: { $slice: [Record<string, unknown>, number] } } }
    expect(conditions.$let.in.$slice[1]).toBe(-MAX_CONDITIONS)
    const entry = (conditions.$let.in.$slice[0] as { $concatArrays: [unknown, [Record<string, unknown>]] }).$concatArrays[1][0]!
    expect(entry).toEqual({
      type: 'crashLoop',
      severity: 'error',
      reason: { $literal: 'exitCode' },
      message: { $literal: '$fieldPath looking text' },
      since: { $ifNull: ['$$existing.since', T0] },
      updatedAt: T0,
      details: { $literal: { logTail: '$$ROOT' } },
    })
  })

  it('omits details when there are none', () => {
    const [stage] = raiseConditionPipeline({ type: 'imagePullFailed', severity: 'error', reason: 'imagePullFailed', message: 'm' }, T0)
    expect(JSON.stringify(stage)).not.toContain('details')
  })
})
