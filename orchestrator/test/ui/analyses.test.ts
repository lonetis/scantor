import { describe, expect, it } from 'vitest'
import { analysisStatusesOf, resultRowFields } from '../../app/composables/useAnalyses'

// The results tab (docs/ui.md §5.13.2): the status filter comes from `?status=` (ScanStats tiles link to
// `?tab=results&status=<status>`, §5.13.1), and rows load a field projection.

describe('analysisStatusesOf', () => {
  it('reads a single status and a comma-separated list in canonical order', () => {
    expect(analysisStatusesOf('failed')).toEqual(['failed'])
    expect(analysisStatusesOf('lost,failed,pending')).toEqual(['pending', 'failed', 'lost'])
  })

  it('reads repeated query keys and drops duplicates', () => {
    expect(analysisStatusesOf(['cancelled', 'failed,cancelled', null])).toEqual(['failed', 'cancelled'])
  })

  it('ignores unknown values and anything that is not a string', () => {
    expect(analysisStatusesOf('failed,bogus,,FAILED')).toEqual(['failed'])
    expect(analysisStatusesOf(undefined)).toEqual([])
    expect(analysisStatusesOf(null)).toEqual([])
    expect(analysisStatusesOf(42)).toEqual([])
  })

  it('normalises a status list (used to compare the filter with the query)', () => {
    expect(analysisStatusesOf(['succeeded', 'pending'])).toEqual(['pending', 'succeeded'])
  })
})

describe('resultRowFields', () => {
  it('projects the row fields plus the chosen result columns', () => {
    expect(resultRowFields(['host', 'port'])).toEqual([
      'id',
      'seq',
      'status',
      'attempt',
      'round',
      'error.type',
      'error.message',
      'timings',
      'files',
      'result.host',
      'result.port',
    ])
  })
})
