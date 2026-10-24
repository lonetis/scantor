import { describe, expect, it } from 'vitest'
import { initialScanFilters } from '../../app/composables/useScans'

// The scans list (docs/ui.md §5.11): `?task=` and `?state=` preselect the filters, so the taskInUse toast's "Show
// active scans" (/scans?task=<id>&state=creating,running,paused) lists the active scans of that task; otherwise the
// remembered filters apply (§14).

const TASK = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'

describe('initialScanFilters', () => {
  it('uses the remembered filters without a query', () => {
    expect(initialScanFilters({}, { state: ['completed'], task: 'other', onlyMine: true })).toEqual({ state: ['completed'], task: 'other', onlyMine: true })
    expect(initialScanFilters({}, {})).toEqual({ state: [], task: null, onlyMine: false })
  })

  it('lets ?task= and ?state= win over the remembered filters', () => {
    expect(initialScanFilters({ task: TASK, state: 'creating,running,paused' }, { state: ['completed'], task: 'other', onlyMine: true })).toEqual({
      state: ['creating', 'running', 'paused'],
      task: TASK,
      onlyMine: true,
    })
  })

  it('keeps the remembered states when only ?task= is given', () => {
    expect(initialScanFilters({ task: TASK }, { state: ['failed'] })).toEqual({ state: ['failed'], task: TASK, onlyMine: false })
  })

  it('reads repeated keys, drops unknown states and ignores empty values', () => {
    expect(initialScanFilters({ task: [TASK, 'second'], state: ['paused', 'bogus,running', null] }, {})).toEqual({ state: ['running', 'paused'], task: TASK, onlyMine: false })
    expect(initialScanFilters({ task: '', state: '' }, { task: 'kept', state: ['completed'] })).toEqual({ state: [], task: 'kept', onlyMine: false })
  })

  it('sanitizes remembered values', () => {
    expect(initialScanFilters({}, { state: ['running', 'nope'] as never, task: 3 as never, onlyMine: 'yes' as never })).toEqual({ state: ['running'], task: null, onlyMine: false })
  })
})
