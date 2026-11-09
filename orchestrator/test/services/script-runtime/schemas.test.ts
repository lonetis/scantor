import { describe, expect, it } from 'vitest'
import {
  completeScriptOutputBody,
  createScriptOutputBody,
  createScriptOutputPartBody,
  jsonByteLength,
  scriptCheckpointBody,
  scriptDescribeBody,
  scriptFinishBody,
  scriptProgressBody,
  streamAnalysesBody,
} from '../../../server/services/script-runtime/schemas'

// Request bodies of the script runtime API (docs/scripts.md): strict and bounded; value sizes that answer 413 are left
// to the routes.

describe('script runtime bodies', () => {
  it('streams analyses with optional status, filter, fields and a seq window', () => {
    expect(streamAnalysesBody.parse({})).toEqual({ fileUrls: true })
    expect(streamAnalysesBody.parse({ status: ['succeeded'], fields: 'all', afterSeq: -1, untilSeq: 10, fileUrls: false })).toMatchObject({
      fields: 'all',
      untilSeq: 10,
    })
    expect(streamAnalysesBody.parse({ fields: ['result.title'], filter: { 'result.ok': true } })).toMatchObject({ fields: ['result.title'] })
    for (const body of [{ status: ['done'] }, { fields: ['$where'] }, { fields: 'some' }, { afterSeq: -2 }, { afterSeq: 5, untilSeq: 5 }, { limit: 1 }]) {
      expect(streamAnalysesBody.safeParse(body).success, JSON.stringify(body)).toBe(false)
    }
  })

  it('takes progress, checkpoints and the describe schemas', () => {
    expect(scriptProgressBody.parse({ done: 5, total: null, message: 'half' })).toEqual({ done: 5, total: null, message: 'half' })
    expect(scriptProgressBody.safeParse({ done: -1 }).success).toBe(false)
    expect(scriptProgressBody.safeParse({ done: 1, message: 'x'.repeat(257) }).success).toBe(false)
    expect(scriptCheckpointBody.parse({ state: null })).toEqual({ state: null })
    expect(scriptCheckpointBody.parse({ state: { afterSeq: 7 } })).toEqual({ state: { afterSeq: 7 } })
    expect(scriptCheckpointBody.safeParse({}).success).toBe(false)
    expect(scriptDescribeBody.parse({ configSchema: { type: 'object' }, resultSchema: null })).toEqual({ configSchema: { type: 'object' }, resultSchema: null })
    expect(scriptDescribeBody.safeParse({ configSchema: { big: 'x'.repeat(256 * 1024) }, resultSchema: null }).success).toBe(false)
    expect(scriptDescribeBody.safeParse({ configSchema: [], resultSchema: null }).success).toBe(false)
  })

  it('finishes with exactly one of a result or a reported error', () => {
    expect(scriptFinishBody.parse({ result: null })).toEqual({ result: null })
    expect(scriptFinishBody.parse({ result: { analyses: 3 } })).toEqual({ result: { analyses: 3 } })
    expect(scriptFinishBody.parse({ error: { type: 'scriptError', message: 'boom', stack: 'Traceback' } })).toMatchObject({ error: { type: 'scriptError' } })
    for (const body of [
      {},
      { result: 1, error: { type: 'scriptError', message: 'x' } },
      { error: { type: 'crash', message: 'x' } },
      { error: { type: 'validation', message: 'x'.repeat(16 * 1024 + 1) } },
    ]) {
      expect(scriptFinishBody.safeParse(body).success, JSON.stringify(body).slice(0, 60)).toBe(false)
    }
  })

  it('bounds outputs and their multipart parts', () => {
    expect(createScriptOutputBody.parse({ name: 'report.csv', contentType: 'text/csv; charset=utf-8' })).toMatchObject({ name: 'report.csv' })
    for (const name of ['', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(256)]) expect(createScriptOutputBody.safeParse({ name }).success, name).toBe(false)
    expect(createScriptOutputPartBody.safeParse({ partNumber: 10_001, size: 1 }).success).toBe(false)
    expect(createScriptOutputPartBody.safeParse({ partNumber: 1, size: 0 }).success).toBe(false)
    expect(createScriptOutputPartBody.safeParse({ partNumber: 1, size: 5 * 1024 ** 3 + 1 }).success).toBe(false)
    const sha256 = 'a'.repeat(64)
    expect(completeScriptOutputBody.parse({ parts: [{ partNumber: 1, etag: '"e"' }], sha256 })).toMatchObject({ sha256 })
    expect(
      completeScriptOutputBody.safeParse({
        parts: [
          { partNumber: 1, etag: 'e' },
          { partNumber: 1, etag: 'f' },
        ],
        sha256,
      }).success,
    ).toBe(false)
    expect(completeScriptOutputBody.safeParse({ parts: [], sha256 }).success).toBe(false)
    expect(completeScriptOutputBody.safeParse({ parts: [{ partNumber: 1, etag: 'e' }], sha256: 'A'.repeat(64) }).success).toBe(false)
  })

  it('measures JSON values in UTF-8 bytes', () => {
    expect(jsonByteLength(undefined)).toBe(0)
    expect(jsonByteLength('ä')).toBe(4)
    expect(jsonByteLength({ a: 1 })).toBe(7)
  })
})
