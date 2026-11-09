import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RevisionDoc, ScanDoc, ScriptRunDoc } from '../../../server/types/documents'
import { parseConfig } from '../../../server/utils/config'
import { useLogger } from '../../../server/utils/logger'
import { FakeCollection } from '../../helpers/fake-collection'
import { analysis, OWNER, RUN, SCAN, SCRIPT, scan, streamableAnalyses } from './helpers'

// GET /api/script-runtime/bootstrap (docs/scripts.md): decrypted secrets (only here), the run's scans in request order
// with newest seq, counts (exact only after the final recount) and the revision's schemas, the resume block of a
// resumed run, the limits and the S3 origin.

const scriptRuns = new FakeCollection<ScriptRunDoc>('scriptRuns')
const scans = new FakeCollection<ScanDoc>('scans')
const revisions = new FakeCollection<RevisionDoc>('revisions')
const analyses = streamableAnalyses()

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => ({ scriptRuns: scriptRuns.asCollection(), scans: scans.asCollection(), revisions: revisions.asCollection() }),
}))
vi.mock('../../../server/services/query/execute', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/query/execute')>()),
  queryAnalysesCollection: async () => analyses.collection,
}))
vi.mock('../../../server/utils/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/keys')>()
  const keys = actual.createKeyring('script runtime bootstrap test secret')
  return { ...actual, useKeys: () => keys }
})

const { scanCounts, scriptCpus, scriptRuntimeBootstrap } = await import('../../../server/services/script-runtime/bootstrap')
const { sealScriptRunSecrets, unsealScriptRunSecrets, scriptRunSecretsAad } = await import('../../../server/services/script-runtime/secrets')

const SCAN_2 = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918'
const ORIGINAL = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const principal = { kind: 'scriptRun' as const, scriptRun: { id: RUN, userId: OWNER, scriptId: SCRIPT, scanIds: [SCAN_2, SCAN], limit: 100 } }
const config = parseConfig({ SCANTOR_S3_INTERNAL_URL: 'http://rustfs:9000', SCANTOR_MAX_RESULT_BYTES: '2MiB', SCANTOR_SCRIPT_RUN_MAX_OUTPUTS: '7' }).config
const log = useLogger('test')

function run(overrides: Partial<ScriptRunDoc> = {}): ScriptRunDoc {
  return {
    _id: RUN,
    userId: OWNER,
    scriptId: SCRIPT,
    scriptName: 'csp',
    scanIds: [SCAN_2, SCAN],
    state: 'running',
    input: { config: { minBytes: 3 }, settings: { timeoutMs: 3_600_000, resources: { cpus: 2.5, memoryMiB: 2048 }, limit: 100 } },
    secrets: sealScriptRunSecrets(RUN, { API_TOKEN: 's3cr3t', OTHER: 'x' }),
    restartedFrom: null,
    outputs: [],
    checkpoint: null,
    startedAt: new Date('2026-01-01T10:00:00Z'),
    ...overrides,
  } as ScriptRunDoc
}

beforeEach(async () => {
  await scriptRuns.insertOne(run())
  await scans.insertOne(
    scan({ state: 'completed', completedAt: new Date('2026-01-01T09:00:00Z'), stats: { ...scan().stats, recountedAt: new Date('2026-01-01T09:00:01Z') } }),
  )
  await scans.insertOne(scan({ _id: SCAN_2, name: null, state: 'running', revision: { id: 'rev-2', number: 1, language: 'python' } as ScanDoc['revision'] }))
  await revisions.insertOne({
    _id: 'rev-1',
    description: { schemas: { analysisConfig: { type: 'object' }, result: { type: 'object', title: 'Result' } }, fileRefPaths: ['/report'] },
  } as unknown as RevisionDoc)
  for (const seq of [0, 4, 17]) await analyses.fake.insertOne(analysis(seq))
})

afterEach(async () => {
  for (const collection of [scriptRuns, scans, revisions, analyses.fake]) await collection.deleteMany({})
})

describe('scriptRuntimeBootstrap', () => {
  it('returns the run with its secrets, the scans in request order, the limits and the S3 origin', async () => {
    const bootstrap = await scriptRuntimeBootstrap(principal, config, log)
    expect(bootstrap.scriptRun).toEqual({
      id: RUN,
      scriptId: SCRIPT,
      scriptName: 'csp',
      config: { minBytes: 3 },
      secrets: { API_TOKEN: 's3cr3t', OTHER: 'x' },
      settings: { timeoutMs: 3_600_000, resources: { cpus: 2.5, memoryMiB: 2048 }, limit: 100 },
      cpus: 2,
      startedAt: '2026-01-01T10:00:00.000Z',
      deadline: '2026-01-01T11:00:00.000Z',
    })
    expect(bootstrap.scans.map((entry) => entry.id)).toEqual([SCAN_2, SCAN])
    expect(bootstrap.scans[1]).toEqual({
      id: SCAN,
      name: 'scan one',
      state: 'completed',
      task: { id: 't', name: 'files' },
      revision: { id: 'rev-1', number: 3 },
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T09:00:00.000Z',
      maxSeq: 17,
      counts: { total: 4, pending: 0, retrying: 0, succeeded: 3, failed: 1, lost: 0, cancelled: 0, hint: false },
      schemas: { analysisConfig: { type: 'object' }, result: { type: 'object', title: 'Result' } },
      fileRefPaths: ['/report'],
      secretPaths: { analysisConfig: ['/token'], result: [] },
    })
    // A running scan reports its hint counters; a revision without description gives no schemas.
    expect(bootstrap.scans[0]).toMatchObject({ name: null, counts: { hint: true }, schemas: { analysisConfig: null, result: null }, fileRefPaths: [] })
    expect(bootstrap.resume).toBeNull()
    expect(bootstrap.limits).toEqual({
      maxResultBytes: 2 * 1024 ** 2,
      maxCheckpointBytes: 1024 ** 2,
      maxOutputs: 7,
      maxOutputBytes: config.scriptRunMaxOutputBytes,
      partBytes: 16 * 1024 ** 2,
      fileUrlTtlSeconds: 3600,
      maxStreams: 4,
      progressIntervalMs: 1000,
      checkpointIntervalMs: 10_000,
    })
    expect(bootstrap.s3Origin).toBe('http://rustfs:9000')
  })

  it('adds the checkpoint and stored outputs of the run a resumed run continues', async () => {
    const stored = {
      id: 'o1',
      name: 'a.csv',
      key: 'k',
      contentType: 'text/csv',
      state: 'stored',
      uploadId: null,
      reservedBytes: 0,
      size: 5,
      sha256: 'd'.repeat(64),
      createdAt: new Date(),
      storedAt: new Date(),
    }
    await scriptRuns.insertOne(
      run({
        _id: ORIGINAL,
        state: 'failed',
        checkpoint: { state: { afterSeq: 4 }, savedAt: new Date(), bytes: 14 },
        outputs: [stored, { ...stored, id: 'o2', name: 'b.csv', state: 'pending', size: null, sha256: null }] as ScriptRunDoc['outputs'],
      }),
    )
    await scriptRuns.updateOne({ _id: RUN }, { $set: { restartedFrom: { id: ORIGINAL, resume: true } } })
    expect((await scriptRuntimeBootstrap(principal, config, log)).resume).toEqual({
      runId: ORIGINAL,
      checkpoint: { afterSeq: 4 },
      outputs: [{ id: 'o1', name: 'a.csv', size: 5, sha256: 'd'.repeat(64), contentType: 'text/csv' }],
    })
    await scriptRuns.updateOne({ _id: RUN }, { $set: { restartedFrom: { id: ORIGINAL, resume: false } } })
    expect((await scriptRuntimeBootstrap(principal, config, log)).resume).toBeNull()
  })

  it('is 404 when a scan of the run was deleted meanwhile and 401 once the run stopped', async () => {
    await scans.updateOne({ _id: SCAN }, { $set: { state: 'deleting' } })
    await expect(scriptRuntimeBootstrap(principal, config, log)).rejects.toMatchObject({ code: 'notFound' })
    await scriptRuns.updateOne({ _id: RUN }, { $set: { state: 'cancelled' } })
    await expect(scriptRuntimeBootstrap(principal, config, log)).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('is 500 when the sealed secrets do not open', async () => {
    await scriptRuns.updateOne({ _id: RUN }, { $set: { secrets: sealScriptRunSecrets(ORIGINAL, { A: 'b' }) } })
    await expect(scriptRuntimeBootstrap(principal, config, log)).rejects.toMatchObject({ code: 'internal' })
  })
})

describe('script-run secrets', () => {
  it('round-trips the values bound to their run', () => {
    const sealed = sealScriptRunSecrets(RUN, { A: '1', B: 'two' })
    expect(sealed?.names).toEqual(['A', 'B'])
    expect(sealed?.enc).not.toContain('two')
    expect(unsealScriptRunSecrets({ _id: RUN, secrets: sealed })).toEqual({ A: '1', B: 'two' })
    expect(() => unsealScriptRunSecrets({ _id: ORIGINAL, secrets: sealed })).toThrow()
    expect(sealScriptRunSecrets(RUN, {})).toBeNull()
    expect(unsealScriptRunSecrets({ _id: RUN, secrets: null })).toEqual({})
    expect(scriptRunSecretsAad(RUN)).toBe(`scriptRuns:${RUN}:secrets`)
  })
})

describe('scanCounts', () => {
  const base = scan()
  it('is exact only for an ended scan recounted at or after its end', () => {
    const ended = new Date('2026-01-01T09:00:00Z')
    expect(scanCounts({ ...base, state: 'completed', completedAt: ended, stats: { ...base.stats, recountedAt: ended } }).hint).toBe(false)
    expect(scanCounts({ ...base, state: 'completed', completedAt: ended, stats: { ...base.stats, recountedAt: new Date('2026-01-01T08:59:59Z') } }).hint).toBe(
      true,
    )
    expect(scanCounts({ ...base, state: 'running', stats: { ...base.stats, recountedAt: ended } }).hint).toBe(true)
    expect(scanCounts({ ...base, state: 'cancelled', completedAt: null, stats: { ...base.stats, recountedAt: null } }).hint).toBe(true)
  })
})

describe('scriptCpus', () => {
  it('is the whole number of CPUs, at least 1', () => {
    expect([scriptCpus(null), scriptCpus(0.5), scriptCpus(1), scriptCpus(3.9)]).toEqual([1, 1, 1, 3])
  })
})
