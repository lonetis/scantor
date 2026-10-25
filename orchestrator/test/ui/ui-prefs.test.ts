import { describe, expect, it } from 'vitest'
import { UI_PREFS_LIMITS, emptyUiPrefs, sanitizeUiPrefs, stripPaths, touchLru } from '../../app/utils/ui-prefs'

describe('sanitizeUiPrefs (docs/ui.md §14)', () => {
  it('discards unknown versions and garbage', () => {
    expect(sanitizeUiPrefs({ v: 2, filters: { scans: {} } })).toEqual(emptyUiPrefs())
    expect(sanitizeUiPrefs('nope')).toEqual(emptyUiPrefs())
    expect(sanitizeUiPrefs(null)).toEqual(emptyUiPrefs())
  })

  it('keeps valid entries and drops malformed ones', () => {
    const prefs = sanitizeUiPrefs({
      v: 1,
      tables: { scans: { pageSize: 50 } },
      resultColumns: { t1: { at: 2, value: ['a', 'b'] }, t2: { at: 1, value: [1] } },
      queries: { s1: { at: 1, value: [{ filter: {} }] } },
      testRunDrafts: { t1: { at: 1, value: { limit: 5 } }, t2: { at: 1, value: 'x' } },
      filters: { scans: { state: ['running'] }, bad: 3, ['__proto__']: { state: [] } },
    })
    // Keys the store no longer knows (table preferences of earlier builds) are dropped.
    expect(prefs).not.toHaveProperty('tables')
    expect(Object.keys(prefs.resultColumns)).toEqual(['t1'])
    expect(prefs.queries.s1!.value).toEqual([{ filter: {} }])
    expect(Object.keys(prefs.testRunDrafts)).toEqual(['t1'])
    expect(prefs.filters).toEqual({ scans: { state: ['running'] } })
  })

  it('enforces the LRU bounds when reading', () => {
    const resultColumns = Object.fromEntries(Array.from({ length: UI_PREFS_LIMITS.resultColumnTasks + 5 }, (_, index) => [`t${index}`, { at: index, value: ['a'] }]))
    const prefs = sanitizeUiPrefs({ v: 1, resultColumns })
    expect(Object.keys(prefs.resultColumns)).toHaveLength(UI_PREFS_LIMITS.resultColumnTasks)
    expect(prefs.resultColumns.t0).toBeUndefined()
  })
})

describe('touchLru', () => {
  it('evicts the least recently used entries above the limit', () => {
    let map = {}
    map = touchLru(map, 'a', 1, 2, 1)
    map = touchLru(map, 'b', 2, 2, 2)
    map = touchLru(map, 'a', 3, 2, 3)
    map = touchLru(map, 'c', 4, 2, 4)
    expect(Object.keys(map).sort()).toEqual(['a', 'c'])
  })
})

describe('stripPaths', () => {
  it('removes writeOnly values before drafts are stored', () => {
    const draft = { taskConfig: { apiKey: 's3cret', greeting: 'hi', auth: [{ token: 't', user: 'u' }] }, limit: 5 }
    expect(stripPaths(draft, ['/taskConfig/apiKey', '/taskConfig/auth/*/token'])).toEqual({ taskConfig: { greeting: 'hi', auth: [{ user: 'u' }] }, limit: 5 })
    expect(draft.taskConfig.apiKey).toBe('s3cret')
  })
})
