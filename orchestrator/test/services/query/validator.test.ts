import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { aggregateAnalysesBody, exportScanBody, queryAnalysesBody } from '#shared/schemas/analyses'
import { validateExportSelection } from '../../../server/services/exports/service'
import { checkPipelineInput, checkQueryInput, scopedPipeline } from '../../../server/services/query/execute'
import { scopedFilter } from '../../../server/services/query/scope'
import { MAX_SAMPLE_SIZE, validatePipeline } from '../../../server/services/query/validator'
import { ApiError } from '../../../server/utils/errors'
import { readRepoFile } from '../../helpers/repo'

// The recursive query allowlist (docs/api.md §5.2, security.md Q-1, Q-2, Q-3, Q-8) over the shared corpus
// tests/corpora/query-injection/cases.json, which the Playwright security suite replays through the API.

type Operation = 'queryAnalyses' | 'aggregateAnalyses' | 'exportScan'

interface CorpusCase {
  id: string
  description: string
  operation: Operation
  body?: Record<string, unknown>
  /** the raw JSON body, for keys such as `__proto__` that an object literal cannot carry */
  bodyJson?: string
  expect: { rejected: boolean; path?: string; pathPrefix?: string; scoped?: boolean }
}

const corpus = JSON.parse(readRepoFile('tests/corpora/query-injection/cases.json')) as { version: number; cases: CorpusCase[] }

const scan = {
  _id: '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f',
  userId: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11',
  secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: [], result: [] },
}

const schemas: Record<Operation, z.ZodType> = {
  queryAnalyses: queryAnalysesBody,
  aggregateAnalyses: aggregateAnalysesBody,
  exportScan: exportScanBody,
}

function bodyOf(entry: CorpusCase): unknown {
  return entry.bodyJson === undefined ? entry.body : JSON.parse(entry.bodyJson)
}

/** Runs exactly the checks the route runs before a query reaches MongoDB. */
function check(entry: CorpusCase): Record<string, unknown> {
  const parsed = schemas[entry.operation].safeParse(bodyOf(entry))
  if (!parsed.success) throw new Error(`case ${entry.id}: the request schema rejected the body: ${parsed.error.message}`)
  const body = parsed.data as Record<string, unknown>
  if (entry.operation === 'queryAnalyses') checkQueryInput(scan, body as never)
  else if (entry.operation === 'aggregateAnalyses') checkPipelineInput(scan, body.pipeline)
  else validateExportSelection(scan, (body.filter as Record<string, unknown> | undefined) ?? {}, body.fields as string[] | undefined)
  return body
}

function rejection(fn: () => unknown): ApiError {
  try {
    fn()
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

describe('query injection corpus', () => {
  it('is well-formed', () => {
    expect(corpus.version).toBe(1)
    const ids = corpus.cases.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of corpus.cases) {
      expect(['queryAnalyses', 'aggregateAnalyses', 'exportScan']).toContain(entry.operation)
      expect(entry.body === undefined).not.toBe(entry.bodyJson === undefined)
      if (entry.expect.rejected) expect(entry.expect.path ?? entry.expect.pathPrefix).toBeTruthy()
    }
  })

  for (const entry of corpus.cases) {
    if (entry.expect.rejected) {
      it(`rejects ${entry.id}: ${entry.description}`, () => {
        const error = rejection(() => check(entry))
        expect(error.code).toBe('queryRejected')
        expect(error.statusCode).toBe(400)
        const path = String(error.details?.path)
        if (entry.expect.path !== undefined) expect(path).toBe(entry.expect.path)
        else expect(path.startsWith(entry.expect.pathPrefix!)).toBe(true)
      })
    } else {
      it(`accepts ${entry.id}: ${entry.description}`, () => {
        const body = check(entry)
        if (!entry.expect.scoped) return
        // The scope is built anew and $and-combined with the untouched user input: it can only narrow.
        if (entry.operation === 'aggregateAnalyses') {
          const pipeline = scopedPipeline(scan, body.pipeline as never, 10)
          expect(pipeline[0]).toEqual({ $match: { $and: [{ scanId: scan._id }, { userId: scan.userId }] } })
          expect(pipeline.slice(2, -1)).toEqual(body.pipeline)
        } else {
          const filter = (body.filter as Record<string, unknown> | undefined) ?? {}
          const scoped = scopedFilter(scan, filter)
          expect(scoped).toEqual({ $and: [{ scanId: scan._id }, { userId: scan.userId }, filter] })
          expect((scoped.$and as unknown[])[2]).toBe(filter)
        }
      })
    }
  }
})

describe('validatePipeline', () => {
  it('accepts $sample up to the cap', () => {
    expect(() => validatePipeline([{ $sample: { size: MAX_SAMPLE_SIZE } }])).not.toThrow()
  })

  it('rejects malformed stages with their path', () => {
    expect(rejection(() => validatePipeline({ $match: {} })).details?.path).toBe('pipeline')
    expect(rejection(() => validatePipeline(['$match'])).details?.path).toBe('pipeline.0')
    expect(rejection(() => validatePipeline([{}])).details?.path).toBe('pipeline.0')
    expect(rejection(() => validatePipeline([{ $sample: { size: 1, extra: 1 } }])).details?.path).toBe('pipeline.0.$sample')
    expect(rejection(() => validatePipeline([{ $facet: [] }])).details?.path).toBe('pipeline.0.$facet')
    expect(rejection(() => validatePipeline([{ $facet: { a: { $match: {} } } }])).details?.path).toBe('pipeline.0.$facet.a')
  })

  it('rejects NUL characters in keys', () => {
    expect(rejection(() => validatePipeline([{ $match: { 'a\0b': 1 } }])).details?.path).toBe('pipeline.0.$match.a\0b')
  })
})

describe('secret references', () => {
  const secretScan = {
    ...scan,
    secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: ['/apiKey', '/items/*/token'], result: ['/session'] },
  }

  it('rejects filters, sorts and pipelines that address a secret', () => {
    const cases: [() => void, string][] = [
      [() => checkQueryInput(secretScan, { filter: { 'config.apiKey': 'x' } }), 'filter.config.apiKey'],
      // An equality on the whole config would reveal the secret inside it.
      [() => checkQueryInput(secretScan, { filter: { config: { apiKey: 'x' } } }), 'filter.config'],
      [() => checkQueryInput(secretScan, { filter: { 'config.items.token': { $exists: true } } }), 'filter.config.items.token'],
      [() => checkQueryInput(secretScan, { filter: { config: { $eq: {} } } }), 'filter.config'],
      [() => checkQueryInput(secretScan, { filter: { $expr: { $eq: ['$result.session', 'x'] } } }), 'filter.$expr.$eq.0'],
      [() => checkQueryInput(secretScan, { filter: {}, sort: { 'result.session': 1 } }), 'sort.result.session'],
      [() => checkQueryInput(secretScan, { filter: {}, projection: { leaked: '$config.apiKey' } }), 'projection.leaked'],
      [() => checkPipelineInput(secretScan, [{ $project: { k: '$config' } }]), 'pipeline.0.$project.k'],
      [() => checkPipelineInput(secretScan, [{ $replaceRoot: { newRoot: '$$ROOT' } }]), 'pipeline.0.$replaceRoot.newRoot'],
      [() => checkPipelineInput(secretScan, [{ $group: { _id: '$config.items.0.token' } }]), 'pipeline.0.$group._id'],
      [() => checkPipelineInput(secretScan, [{ $addFields: { x: { $getField: { field: 'apiKey', input: '$seq' } } } }]), 'pipeline.0.$addFields.x.$getField'],
      // $jsonSchema tests field values without a `$path`, also without naming the field (patternProperties).
      [
        () => checkQueryInput(secretScan, { filter: { $jsonSchema: { properties: { config: { properties: { apiKey: { pattern: '^s' } } } } } } }),
        'filter.$jsonSchema',
      ],
      [
        () => checkQueryInput(secretScan, { filter: { $jsonSchema: { properties: { config: { patternProperties: { '^api': { pattern: '^s' } } } } } } }),
        'filter.$jsonSchema',
      ],
      [() => checkPipelineInput(secretScan, [{ $match: { $jsonSchema: { required: ['seq'] } } }]), 'pipeline.0.$match.$jsonSchema'],
    ]
    for (const [fn, path] of cases) {
      const error = rejection(fn)
      expect(error.code).toBe('queryRejected')
      expect(error.details?.path).toBe(path)
    }
  })

  it('allows plain projections of secret paths (masked afterwards) and unrelated references', () => {
    expect(() => checkQueryInput(secretScan, { filter: { 'config.origin': 'x' }, projection: { config: 1 } })).not.toThrow()
    expect(() => checkPipelineInput(secretScan, [{ $group: { _id: '$config.origin', n: { $sum: 1 } } }])).not.toThrow()
    expect(() => checkPipelineInput(scan, [{ $replaceRoot: { newRoot: '$$ROOT' } }])).not.toThrow()
    // Without secret paths, $jsonSchema reveals nothing that a filter could not.
    expect(() => checkQueryInput(scan, { filter: { $jsonSchema: { properties: { config: { patternProperties: { '^api': { pattern: '^s' } } } } } } })).not.toThrow()
  })

  it('removes secret paths before user stages run', () => {
    const pipeline = scopedPipeline(secretScan, [{ $count: 'n' }], 5)
    expect(pipeline[1]).toEqual({ $unset: ['files.key', 'config.apiKey', 'config.items', 'result.session'] })
    expect(pipeline.at(-1)).toEqual({ $limit: 6 })
  })
})
