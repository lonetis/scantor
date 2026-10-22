import { describe, expect, it } from 'vitest'
import { analysisFileKey, type PresignInput, presignProblems } from '../../../server/services/runtime/uploads'
import { SCAN_ID } from '../nodes/helpers'

// POST /api/runtime/uploads/presign (docs/api.md §8.3, security.md ING-5, RES-5): server-generated keys inside the
// scan prefix, runtime-generated uuid v4 file ids validated, limits per call.

const EXECUTION = 'b2f1c0d9-8e7a-4b6c-9d5e-4f3a2b1c0d9e'
const FILE_1 = 'e0c4b2a1-9f8e-4d7c-8b6a-5f4e3d2c1b0a'
const FILE_2 = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const limits = { maxFileBytes: 1024 ** 3, maxFilesPerAnalysis: 2, maxAnalysesPerScan: 1_000_000 }

function input(files: PresignInput['files'], overrides: Partial<PresignInput> = {}): PresignInput {
  return { seq: 1234, round: 1, attempt: 2, executionId: EXECUTION, files, ...overrides }
}

const file = (fileId: string, name: string, size = 48213) => ({ fileId, name, size, sha256: 'a'.repeat(64), contentType: 'image/png' })

describe('analysisFileKey', () => {
  it('builds files/<scanId>/<seq>/<executionId>/<fileId>/<safeName>', () => {
    expect(analysisFileKey(SCAN_ID, 1234, EXECUTION, FILE_1, 'screenshot.png')).toBe(`files/${SCAN_ID}/1234/${EXECUTION}/${FILE_1}/screenshot.png`)
  })

  it('keeps path-like and unicode names inside the prefix', () => {
    expect(analysisFileKey(SCAN_ID, 1, EXECUTION, FILE_1, '..')).toBe(`files/${SCAN_ID}/1/${EXECUTION}/${FILE_1}/__`)
    expect(analysisFileKey(SCAN_ID, 1, EXECUTION, FILE_1, 'a b/../c.txt')).toBe(`files/${SCAN_ID}/1/${EXECUTION}/${FILE_1}/a_b_.._c.txt`)
    expect(analysisFileKey(SCAN_ID, 1, EXECUTION, FILE_1, 'résumé.pdf')).toBe(`files/${SCAN_ID}/1/${EXECUTION}/${FILE_1}/r_sum_.pdf`)
  })
})

describe('presignProblems', () => {
  const scan = { round: 1 }

  it('accepts a valid request', () => {
    expect(presignProblems(input([file(FILE_1, 'a.png'), file(FILE_2, 'b.png')]), scan, limits)).toEqual([])
  })

  it('rejects malformed and duplicate file ids, duplicate names and oversized files', () => {
    const issues = presignProblems(input([file('not-a-uuid', 'a.png'), file(FILE_1, 'b.png', 2 * 1024 ** 3)]), scan, limits)
    expect(issues.map((issue) => issue.path)).toEqual(['files.0.fileId', 'files.1.size'])
    expect(presignProblems(input([file(FILE_1, 'a.png'), file(FILE_1, 'b.png')]), scan, limits).map((issue) => issue.message)).toEqual(['duplicate fileId'])
    expect(presignProblems(input([file(FILE_1, 'a.png'), file(FILE_2, 'a.png')]), scan, limits).map((issue) => issue.message)).toEqual(['duplicate file name'])
    // uuid v1 is not a runtime-generated v4 id
    expect(presignProblems(input([file('e0c4b2a1-9f8e-1d7c-8b6a-5f4e3d2c1b0a', 'a.png')]), scan, limits)).toHaveLength(1)
  })

  it('rejects too many files, seqs out of range and rounds newer than the scan', () => {
    expect(presignProblems(input([file(FILE_1, 'a'), file(FILE_2, 'b'), file('c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f', 'c')]), scan, limits)[0]!.path).toBe('files')
    expect(presignProblems(input([], { seq: 1_000_000 }), scan, limits)[0]!.path).toBe('seq')
    expect(presignProblems(input([], { round: 2 }), scan, limits)[0]!.path).toBe('round')
  })
})
