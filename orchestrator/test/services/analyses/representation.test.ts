import { describe, expect, it } from 'vitest'
import { inclusionProjection, normalizeFieldPaths, pickPaths } from '../../../server/services/analyses/fields'
import { analysisMaskPatterns, analysisSecretSegments } from '../../../server/services/analyses/masking'
import { toApiAnalysis, toApiDocument } from '../../../server/services/analyses/representation'
import type { AnalysisDoc } from '../../../server/types/documents'
import { ApiError } from '../../../server/utils/errors'

// The Analysis representation (docs/api.md §2): id, ISO timestamps, no internal file keys, writeOnly values masked
// (security.md SEC-2), and the `fields` projection of listAnalyses and exports.

const SCAN = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
const at = new Date('2026-10-21T10:00:00.000Z')

const doc: AnalysisDoc = {
  _id: `${SCAN}-3`,
  scanId: SCAN,
  userId: 'u',
  seq: 3,
  round: 1,
  status: 'succeeded',
  attempt: 1,
  config: { origin: 'x', apiKey: 'secret-1', items: [{ token: 'secret-2' }, { token: 'secret-3' }] },
  result: { title: 'T', session: 'secret-4' },
  attempts: [
    { attempt: 1, round: 1, executionId: 'e', workerId: null, nodeId: null, startedAt: at, finishedAt: at, durationMs: 5, error: null, logTail: '' },
  ],
  files: [{ id: 'f', name: 'a.png', size: 1, sha256: 'a'.repeat(64), contentType: 'image/png', key: `files/${SCAN}/3/e/f/a.png` }],
  logTail: 'log',
  timings: { scheduledAt: at, startedAt: at, finishedAt: at, durationMs: 5 },
  createdAt: at,
  updatedAt: at,
}

const secretPaths = { taskConfig: [], scanConfig: [], analysisConfig: ['/apiKey', '/items/*/token'], result: ['/session'] }

describe('toApiAnalysis', () => {
  it('maps the document and masks secrets', () => {
    const analysis = toApiAnalysis(doc, analysisMaskPatterns(secretPaths))
    expect(analysis.id).toBe(`${SCAN}-3`)
    expect(analysis.createdAt).toBe('2026-10-21T10:00:00.000Z')
    expect(analysis.files).toEqual([{ id: 'f', name: 'a.png', size: 1, sha256: 'a'.repeat(64), contentType: 'image/png' }])
    expect(analysis.config).toEqual({ origin: 'x', apiKey: '***', items: [{ token: '***' }, { token: '***' }] })
    expect(analysis.result).toEqual({ title: 'T', session: '***' })
    expect(JSON.stringify(analysis)).not.toMatch(/secret-\d/)
    // The stored document is never modified by masking.
    expect(doc.config?.apiKey).toBe('secret-1')
  })
})

describe('toApiDocument', () => {
  it('renames _id, strips file keys and masks projected documents', () => {
    const projected = toApiDocument({ _id: doc._id, seq: 3, files: doc.files, config: { apiKey: 'secret-1' } }, analysisMaskPatterns(secretPaths))
    expect(projected).toEqual({ id: doc._id, seq: 3, files: [{ id: 'f', name: 'a.png', size: 1, sha256: 'a'.repeat(64), contentType: 'image/png' }], config: { apiKey: '***' } })
  })
})

describe('fields', () => {
  it('accepts representation paths, drops nested duplicates and maps id', () => {
    expect(normalizeFieldPaths(['seq', 'result', 'result.title', 'id', 'seq'])).toEqual(['seq', 'result', 'id'])
    expect(inclusionProjection(['id', 'status', 'error.type'])).toEqual({ _id: 1, seq: 1, status: 1, 'error.type': 1 })
  })

  it('rejects unknown fields and internal file keys', () => {
    for (const fields of [['secrets'], ['files.key'], ['files.0.key'], ['id.x']]) {
      expect(() => normalizeFieldPaths(fields)).toThrow(ApiError)
    }
  })

  it('picks nested paths like an inclusion projection', () => {
    expect(pickPaths({ a: { b: 1, c: 2 }, d: 3 }, ['a.b', 'd', 'x.y'])).toEqual({ a: { b: 1 }, d: 3 })
  })
})

describe('secret segments', () => {
  it('turns secret pointers into document paths', () => {
    expect(analysisSecretSegments(secretPaths)).toEqual([['config', 'apiKey'], ['config', 'items', '*', 'token'], ['result', 'session']])
    expect(analysisSecretSegments(null)).toEqual([])
  })
})
