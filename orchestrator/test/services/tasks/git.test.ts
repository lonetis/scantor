import { describe, expect, it } from 'vitest'
import { selectCandidates } from '../../../server/services/tasks/git'
import type { GitCandidate } from '../../../server/services/helpers/types'
import { ApiError } from '../../../server/utils/errors'

// Candidate selection of importGitTask (docs/tasks.md §14).

function candidate(path: string, valid = true): GitCandidate {
  return {
    path,
    name: path.replaceAll('/', '-'),
    language: 'python',
    valid,
    errors: valid ? [] : [{ phase: 'static', file: 'scantor.yaml', line: 3, message: 'name: must match pattern' }],
    summary: valid ? { packSha256: 'a', fileCount: 1, bytes: 1 } : null,
  }
}

function errorCode(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof ApiError ? error.code : 'other'
  }
}

describe('selectCandidates', () => {
  it('imports the only valid candidate', () => {
    expect(selectCandidates([candidate('a'), candidate('b', false)], undefined)?.map((c) => c.path)).toEqual(['a'])
  })

  it('asks for a selection when several candidates are valid', () => {
    expect(selectCandidates([candidate('a'), candidate('b')], undefined)).toBeNull()
  })

  it('imports the selected candidates', () => {
    expect(selectCandidates([candidate('a'), candidate('b'), candidate('c')], ['c', 'a'])?.map((c) => c.path)).toEqual(['c', 'a'])
  })

  it('rejects unknown and invalid selections and repositories without a valid manifest', () => {
    expect(errorCode(() => selectCandidates([candidate('a')], ['x']))).toBe('badRequest')
    expect(errorCode(() => selectCandidates([candidate('a', false)], ['a']))).toBe('manifestInvalid')
    expect(errorCode(() => selectCandidates([candidate('a', false)], undefined))).toBe('manifestInvalid')
    expect(errorCode(() => selectCandidates([], undefined))).toBe('manifestInvalid')
  })

  it('reports the manifest errors as BuildErrors', () => {
    try {
      selectCandidates([candidate('a', false)], undefined)
    } catch (error) {
      expect((error as ApiError).details).toEqual({ errors: [{ phase: 'static', file: 'scantor.yaml', line: 3, message: 'name: must match pattern' }] })
    }
  })
})
