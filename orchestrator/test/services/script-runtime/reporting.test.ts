import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptDoc, ScriptRunDoc } from '../../../server/types/documents'
import { parseConfig, setConfigForTesting } from '../../../server/utils/config'
import { FakeCollection } from '../../helpers/fake-collection'
import { OWNER, RUN, SCAN, SCRIPT, scan } from './helpers'

// The reporting routes of the script runtime API (docs/scripts.md): finish (exactly one outcome, size and storage
// checks, last call wins), describe (stored on the script for the run's pack), single file URLs, aggregations and the
// per-run read slots.

const scriptRuns = new FakeCollection<ScriptRunDoc>('scriptRuns')
const scripts = new FakeCollection<ScriptDoc>('scripts')
vi.mock('../../../server/utils/mongo', () => ({ useCollections: () => ({ scriptRuns: scriptRuns.asCollection(), scripts: scripts.asCollection() }) }))
const query = vi.hoisted(() => ({ aggregateAnalyses: vi.fn(async () => ({ items: [{ _id: 'succeeded', n: 3 }], truncated: false })) }))
vi.mock('../../../server/services/query/execute', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/query/execute')>()),
  ...query,
}))

vi.mock('../../../server/utils/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/keys')>()
  const keys = actual.createKeyring('script runtime reporting test secret')
  return { ...actual, useKeys: () => keys }
})

const { finishScriptRun } = await import('../../../server/services/script-runtime/finish')
const { sealScriptRunSecrets } = await import('../../../server/services/script-runtime/secrets')
const { describeScript } = await import('../../../server/services/script-runtime/describe')
const { aggregateRunAnalyses, runFileUrl } = await import('../../../server/services/script-runtime/reads')
const { acquireRunReadSlot, activeRunReads } = await import('../../../server/services/script-runtime/limiter')
const { assertStorableJson, MAX_STORED_JSON_DEPTH } = await import('../../../server/services/script-runtime/limits')

const principal = { kind: 'scriptRun' as const, scriptRun: { id: RUN, userId: OWNER, scriptId: SCRIPT, scanIds: [SCAN], limit: null } }
const PACK = 'e'.repeat(64)

beforeEach(async () => {
  await scriptRuns.insertOne({
    _id: RUN,
    userId: OWNER,
    scriptId: SCRIPT,
    state: 'running',
    source: { packSha256: PACK },
    result: null,
    error: null,
  } as unknown as ScriptRunDoc)
  await scripts.insertOne({ _id: SCRIPT, userId: OWNER, name: 'csp', describe: null } as unknown as ScriptDoc)
})

afterEach(async () => {
  await scriptRuns.deleteMany({})
  await scripts.deleteMany({})
})

describe('finishScriptRun', () => {
  const config = { maxResultBytes: 64 }

  it('stores a result and replaces an earlier reported error', async () => {
    await finishScriptRun(principal, { error: { type: 'scriptError', message: 'first' } }, config)
    expect(await finishScriptRun(principal, { result: { analyses: 3, withCsp: 1 } }, config)).toEqual({ received: 'result' })
    expect(await scriptRuns.findOne({ _id: RUN })).toMatchObject({ result: { analyses: 3, withCsp: 1 }, error: null })
  })

  it('stores a reported error with its stack and clears the result', async () => {
    await finishScriptRun(principal, { result: 1 }, config)
    expect(await finishScriptRun(principal, { error: { type: 'validation', message: 'bad config', stack: 'trace' } }, config)).toEqual({ received: 'error' })
    expect(await scriptRuns.findOne({ _id: RUN })).toMatchObject({ result: null, error: { type: 'validation', message: 'bad config', stack: 'trace' } })
  })

  it("masks the run's secret values and tokens in the reported message and stack", async () => {
    await scriptRuns.updateOne({ _id: RUN }, { $set: { secrets: sealScriptRunSecrets(RUN, { API_TOKEN: 'TOPSECRET1', SHORT: 'abc' }) } })
    const token = `ssr_${RUN}.${'A'.repeat(43)}`
    await finishScriptRun(
      principal,
      { error: { type: 'scriptError', message: 'login with TOPSECRET1 failed (abc)', stack: `Traceback\n  token=${token}\nKeyError: TOPSECRET1` } },
      config,
    )
    const stored = (await scriptRuns.findOne({ _id: RUN }))?.error
    expect(stored).toEqual({ type: 'scriptError', message: 'login with *** failed (abc)', stack: 'Traceback\n  token=ssr_***\nKeyError: ***' })
  })

  it('accepts a null result', async () => {
    await finishScriptRun(principal, { result: null }, config)
    expect((await scriptRuns.findOne({ _id: RUN }))?.result).toBeNull()
  })

  it('refuses a result above SCANTOR_MAX_RESULT_BYTES (413) and one MongoDB cannot store (400)', async () => {
    await expect(finishScriptRun(principal, { result: 'x'.repeat(63) }, config)).rejects.toMatchObject({ code: 'payloadTooLarge', statusCode: 413 })
    await expect(finishScriptRun(principal, { result: { nested: { $set: 1 } } }, config)).rejects.toMatchObject({ code: 'validationFailed' })
  })

  it('answers 401 once the run is no longer running', async () => {
    await scriptRuns.updateOne({ _id: RUN }, { $set: { state: 'completed' } })
    await expect(finishScriptRun(principal, { result: 1 }, config)).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('describeScript', () => {
  it("stores the schemas on the script for the run's pack", async () => {
    const now = new Date('2026-01-01T00:00:00Z')
    const configSchema = { type: 'object', properties: { minBytes: { type: 'integer', default: 0 } } }
    expect(await describeScript(principal, { configSchema, resultSchema: null }, now)).toEqual({ packSha256: PACK, at: '2026-01-01T00:00:00.000Z' })
    expect((await scripts.findOne({ _id: SCRIPT }))?.describe).toEqual({ packSha256: PACK, configSchema, resultSchema: null, at: now })
  })

  it('is 404 when the script is gone and 401 when the run stopped', async () => {
    await scripts.deleteMany({})
    await expect(describeScript(principal, { configSchema: null, resultSchema: null })).rejects.toMatchObject({ code: 'notFound' })
    await scriptRuns.updateOne({ _id: RUN }, { $set: { state: 'failed' } })
    await expect(describeScript(principal, { configSchema: null, resultSchema: null })).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('runFileUrl', () => {
  beforeEach(() => setConfigForTesting(parseConfig({ SCANTOR_S3_INTERNAL_URL: 'http://rustfs:9000' }).config))
  afterEach(() => setConfigForTesting(null))

  it('presigns a stored file of the analysis for the internal endpoint for one hour', () => {
    const files = [{ id: 'f1', name: 'a b.json', size: 3, sha256: 'a'.repeat(64), contentType: 'application/json', key: `files/${SCAN}/1/e/f1/a_b.json` }]
    const url = runFileUrl({ files }, 'f1', new Date('2026-01-01T00:00:00Z'))
    expect(url).toMatchObject({ name: 'a b.json', size: 3, sha256: 'a'.repeat(64), contentType: 'application/json', expiresAt: '2026-01-01T01:00:00.000Z' })
    expect(url.url.startsWith(`http://rustfs:9000/scantor/files/${SCAN}/1/e/f1/a_b.json?X-Amz-Algorithm=`)).toBe(true)
  })

  it('is 404 for unknown files and FileRefs without a stored object', () => {
    const files = [{ id: 'f2', name: 'x', size: 1, sha256: 'b'.repeat(64), contentType: 'text/plain' }]
    expect(() => runFileUrl({ files }, 'f2')).toThrow(expect.objectContaining({ code: 'notFound' }))
    expect(() => runFileUrl({ files }, 'nope')).toThrow(expect.objectContaining({ code: 'notFound' }))
  })
})

describe('read slots and aggregations', () => {
  it('allows four concurrent reads per run and refuses the fifth with 429', () => {
    const releases = [1, 2, 3, 4].map(() => acquireRunReadSlot(RUN))
    expect(() => acquireRunReadSlot(RUN)).toThrow(expect.objectContaining({ code: 'tooManyRequests' }))
    // Another run has its own budget.
    acquireRunReadSlot('another-run')()
    releases[0]!()
    releases[0]!()
    expect(activeRunReads(RUN)).toBe(3)
    acquireRunReadSlot(RUN)()
    for (const release of releases) release()
    expect(activeRunReads(RUN)).toBe(0)
  })

  it("aggregates with aggregateAnalyses on the run's slots and releases them", async () => {
    const limits = { queryMaxTimeMs: 1000, queryMaxDocs: 100 }
    const body = { pipeline: [{ $group: { _id: '$status', n: { $sum: 1 } } }] }
    expect(await aggregateRunAnalyses(principal, scan(), body, limits)).toEqual({ items: [{ _id: 'succeeded', n: 3 }], truncated: false })
    expect(query.aggregateAnalyses).toHaveBeenCalledWith(scan(), body, limits)
    expect(activeRunReads(RUN)).toBe(0)
    query.aggregateAnalyses.mockRejectedValueOnce(new Error('boom'))
    await expect(aggregateRunAnalyses(principal, scan(), body, limits)).rejects.toThrow('boom')
    expect(activeRunReads(RUN)).toBe(0)
  })
})

describe('assertStorableJson', () => {
  it('refuses $-prefixed and NUL keys and deep nesting, anywhere in the value', () => {
    expect(() => assertStorableJson({ a: [{ b: 'c.d', 'e.f': null }] }, 'result')).not.toThrow()
    expect(() => assertStorableJson([{ ok: { $gt: 1 } }], 'result')).toThrow(expect.objectContaining({ code: 'validationFailed' }))
    expect(() => assertStorableJson({ 'a\0b': 1 }, 'result')).toThrow(expect.objectContaining({ code: 'validationFailed' }))
    let deep: unknown = 1
    for (let level = 0; level <= MAX_STORED_JSON_DEPTH; level++) deep = [deep]
    expect(() => assertStorableJson(deep, 'state')).toThrow(expect.objectContaining({ code: 'validationFailed' }))
    expect(() => assertStorableJson((deep as unknown[])[0], 'state')).not.toThrow()
  })
})
