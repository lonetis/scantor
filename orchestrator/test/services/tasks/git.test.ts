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
    rejection: null,
    summary: valid ? { packSha256: 'a', fileCount: 1, bytes: 1 } : null,
  }
}

const SYMLINK_MESSAGE = '"helper.py" is a symlink; symlinks are not supported in imported tasks'

/** A candidate with a valid manifest whose folder breaks an archive rule (docs/editor.md §9.5). */
function linked(path: string): GitCandidate {
  return {
    ...candidate(path),
    valid: false,
    errors: [{ phase: 'static', file: 'helper.py', message: SYMLINK_MESSAGE }],
    rejection: { code: 'invalidPath', message: SYMLINK_MESSAGE, path: 'helper.py', details: { path: 'helper.py' } },
  }
}

function thrown(fn: () => unknown): ApiError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('nothing was thrown')
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

  it('answers a symlink in the selected folder with invalidPath and the path inside the task folder', () => {
    for (const select of [undefined, ['a']]) {
      const error = thrown(() => selectCandidates([linked('a')], select))
      expect(error.code).toBe('invalidPath')
      expect(error.statusCode).toBe(422)
      expect(error.message).toBe(SYMLINK_MESSAGE)
      expect(error.details).toEqual({ path: 'helper.py' })
    }
    // A valid candidate next to it is still imported on its own.
    expect(selectCandidates([linked('a'), candidate('b')], undefined)?.map((c) => c.path)).toEqual(['b'])
  })

  it('answers a candidate over the task caps with 413 payloadTooLarge', () => {
    const big = { ...candidate('a', false), rejection: { code: 'tooLarge', message: 'the task folder exceeds 1048576 bytes', details: { limit: 1048576 } } }
    const error = thrown(() => selectCandidates([big], ['a']))
    expect(error.code).toBe('payloadTooLarge')
    expect(error.details).toEqual({ limit: 1048576 })
  })

  it('reports the manifest errors as BuildErrors', () => {
    try {
      selectCandidates([candidate('a', false)], undefined)
    } catch (error) {
      expect((error as ApiError).details).toEqual({ errors: [{ phase: 'static', file: 'scantor.yaml', line: 3, message: 'name: must match pattern' }] })
    }
  })
})
