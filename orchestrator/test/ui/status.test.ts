import { describe, expect, it } from 'vitest'
import { STATUS_STATES, severityRank, statusMeta } from '../../app/utils/status'
import type { StatusKind } from '../../app/utils/status'
import {
  ANALYSIS_STATUSES,
  EDITOR_STATES,
  EVENT_LEVELS,
  EXPORT_STATES,
  JOB_STATES,
  NODE_STATES,
  REVISION_STATES,
  SCAN_STATES,
  SCHEDULING_STATES,
  SEVERITIES,
  TEST_RUN_STATES,
  WORKER_STATES,
} from '../../shared/utils/enums'

// docs/ui.md §10: the state → color table is normative.
const EXPECTED: Record<StatusKind, Record<string, string>> = {
  scan: { creating: 'info', running: 'success', paused: 'warning', completed: 'primary', failed: 'error', cancelled: 'neutral', deleting: 'neutral', deleted: 'neutral' },
  scheduling: { pending: 'neutral', running: 'info', done: 'success', retrying: 'warning', failed: 'error' },
  analysis: { pending: 'neutral', retrying: 'warning', succeeded: 'success', failed: 'error', lost: 'warning', cancelled: 'neutral' },
  revision: { queued: 'neutral', building: 'info', ready: 'success', failed: 'error' },
  testRun: { queued: 'neutral', building: 'info', running: 'info', completed: 'success', failed: 'error', cancelled: 'neutral' },
  worker: { pending: 'warning', assigned: 'info', pulling: 'info', starting: 'info', running: 'success', backoff: 'error', draining: 'warning', stopped: 'neutral', lost: 'error' },
  node: { pending: 'neutral', online: 'success', offline: 'error', revoked: 'neutral' },
  export: { queued: 'neutral', running: 'info', ready: 'success', failed: 'error', cancelled: 'neutral' },
  job: { queued: 'neutral', running: 'info', succeeded: 'success', failed: 'error', cancelled: 'neutral' },
  editor: { starting: 'info', running: 'success', stopping: 'warning', stopped: 'neutral' },
  conditionSeverity: { info: 'info', warning: 'warning', error: 'error' },
  eventLevel: { info: 'info', warning: 'warning', error: 'error' },
}

describe('statusMeta', () => {
  for (const [kind, states] of Object.entries(EXPECTED) as [StatusKind, Record<string, string>][]) {
    it(`maps every ${kind} state to the color of the spec table`, () => {
      for (const [state, color] of Object.entries(states)) {
        expect(statusMeta(kind, state).color, `${kind}/${state}`).toBe(color)
      }
      expect([...STATUS_STATES[kind]].sort()).toEqual(Object.keys(states).sort())
    })
  }

  it('always labels the badge with the state text itself', () => {
    for (const kind of Object.keys(EXPECTED) as StatusKind[]) {
      for (const state of STATUS_STATES[kind]) expect(statusMeta(kind, state).label).toBe(state)
    }
  })

  it('pulses only running scans, running workers, online nodes and running editors', () => {
    const pulsing = (Object.keys(EXPECTED) as StatusKind[]).flatMap((kind) =>
      STATUS_STATES[kind].filter((state) => statusMeta(kind, state).pulse).map((state) => `${kind}/${state}`),
    )
    expect(pulsing.sort()).toEqual(['editor/running', 'node/online', 'scan/running', 'worker/running'])
  })

  it('uses only literal lucide icons', () => {
    for (const kind of Object.keys(EXPECTED) as StatusKind[]) {
      for (const state of STATUS_STATES[kind]) expect(statusMeta(kind, state).icon).toMatch(/^i-lucide-[a-z0-9-]+$/)
    }
  })

  it('renders unknown and missing states as neutral with the raw text', () => {
    expect(statusMeta('scan', 'exploded')).toEqual({ color: 'neutral', icon: 'i-lucide-circle-dashed', label: 'exploded', pulse: false })
    expect(statusMeta('job', null).label).toBe('unknown')
    expect(statusMeta('scan', 'toString').color).toBe('neutral')
  })

  it('covers every state of the shared enums (docs/data-model.md §6)', () => {
    const coverage: [StatusKind, readonly string[]][] = [
      ['scan', SCAN_STATES],
      ['scheduling', SCHEDULING_STATES],
      ['analysis', ANALYSIS_STATUSES],
      ['revision', REVISION_STATES],
      ['testRun', TEST_RUN_STATES],
      ['worker', WORKER_STATES],
      ['node', NODE_STATES],
      ['export', EXPORT_STATES],
      ['job', JOB_STATES],
      ['editor', EDITOR_STATES],
      ['conditionSeverity', SEVERITIES],
      ['eventLevel', EVENT_LEVELS],
    ]
    for (const [kind, states] of coverage) {
      for (const state of states) expect(STATUS_STATES[kind], `${kind}/${state}`).toContain(state)
    }
  })
})

describe('severityRank', () => {
  it('sorts errors before warnings before info', () => {
    expect(['info', 'error', 'warning'].sort((a, b) => severityRank(a) - severityRank(b))).toEqual(['error', 'warning', 'info'])
  })
})
