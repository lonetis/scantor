import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, ScanDoc, ScriptDoc, ScriptRunDoc } from '../../../server/types/documents'
import { FakeCollection } from '../../helpers/fake-collection'

// Starting and restarting script runs (docs/scripts.md §5 of the design): the scans must be the script owner's live
// scans (never the admin's power), settings caps and the config size are checked first, the folder snapshot is
// promoted only when every check passed, the config is validated against the schema described for exactly this pack,
// MCP must confirm a run over every analysis, the run is inserted with its job and the script's latestRun, secrets are
// sealed for the new run, and a restart carries the original's inputs with overrides.

const store = {
  scripts: new FakeCollection<ScriptDoc>('scripts'),
  scriptRuns: new FakeCollection<ScriptRunDoc>('scriptRuns'),
  scans: new FakeCollection<ScanDoc>('scans'),
  jobs: new FakeCollection<JobDoc>('jobs'),
}
const s3 = { copies: [] as [string, string][], deleted: [] as string[] }
const snapshots = { taken: [] as unknown[], discarded: [] as string[], packSha256: 'a'.repeat(64) }

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/utils/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/keys')>()
  const keys = actual.createKeyring('script run start test secret')
  return { ...actual, useKeys: () => keys }
})
vi.mock('../../../server/utils/s3', () => ({
  copyObject: async (from: string, to: string) => s3.copies.push([from, to]),
  deleteObject: async (key: string) => s3.deleted.push(key),
}))
vi.mock('../../../server/utils/config', () => ({ useConfig: () => ({ scriptRunRetentionDays: 30, maxConcurrentWaits: 2 }) }))
vi.mock('../../../server/services/pipeline/snapshot', () => ({
  snapshotToTmp: async (userId: string, folder: unknown) => {
    snapshots.taken.push({ userId, folder })
    return { tmpKey: 'tmp/snapshots/x.tar.gz', packSha256: snapshots.packSha256, packBytes: 123, fileCount: 4, bytes: 400 }
  },
  discardTmpSnapshot: async (snapshot: { tmpKey: string }) => snapshots.discarded.push(snapshot.tmpKey),
}))

const { reserveRestartWait, restartScriptRun, sourceKey, startScriptRun } = await import('../../../server/services/script-runs/start')
const { reserveWait } = await import('../../../server/utils/wait')
const { updateLatestRunPointer } = await import('../../../server/services/script-runs/pointer')
const { unsealScriptRunSecrets } = await import('../../../server/services/script-runtime/secrets')

type UserPrincipal = import('../../../server/utils/principal').UserPrincipal

const OWNER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const ADMIN = '6c9b1d2e-7f3a-4b5c-8d9e-0f1a2b3c4d5e'
const SCRIPT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const SCAN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const OTHER_SCAN = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const owner = { kind: 'user', via: 'session', user: { id: OWNER }, isAdmin: false } as unknown as UserPrincipal
const admin = { kind: 'user', via: 'session', user: { id: ADMIN }, isAdmin: true } as unknown as UserPrincipal
const agent = { kind: 'user', via: 'mcp', user: { id: OWNER }, isAdmin: false } as unknown as UserPrincipal
const config = { maxScanConfigBytes: 1024, scriptRunTimeoutMs: 3_600_000, scriptRunMaxCpus: 4, scriptRunMaxMemoryBytes: 4 * 1024 ** 3 }

function script(): ScriptDoc {
  return store.scripts.docs[0] as ScriptDoc
}

function scan(id: string, userId: string, extra: Partial<ScanDoc> = {}) {
  return {
    _id: id,
    userId,
    name: `scan-${id.slice(0, 4)}`,
    state: 'completed',
    completedAt: null,
    stats: { pending: 0, retrying: 0, succeeded: 40, failed: 2, lost: 0, cancelled: 0, expectedTotal: null, ratePerMin: 0, recountedAt: null },
    ...extra,
  }
}

beforeEach(() => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  s3.copies.length = 0
  s3.deleted.length = 0
  snapshots.taken.length = 0
  snapshots.discarded.length = 0
  snapshots.packSha256 = 'a'.repeat(64)
  const now = new Date()
  store.scripts.docs.push({
    _id: SCRIPT_ID,
    userId: OWNER,
    name: 'csp',
    language: 'python',
    description: null,
    source: { kind: 'scaffold' },
    workspace: { packSha256: null, fileCount: 0, bytes: 0, checkedAt: null, lastSyncSha256: null },
    describe: null,
    latestRun: null,
    deletingAt: null,
    createdAt: now,
    updatedAt: now,
  })
  store.scans.docs.push(scan(SCAN, OWNER), scan(OTHER_SCAN, ADMIN))
})

describe('startScriptRun', () => {
  it('queues a run of the snapshot with its job, sealed secrets and the script pointer', async () => {
    const run = await startScriptRun(
      owner,
      script(),
      { scans: [SCAN, SCAN.toUpperCase()], config: { a: 1 }, secrets: { API_TOKEN: 'tok-123' }, settings: { limit: 100 } },
      config,
    )
    expect(run).toMatchObject({
      userId: OWNER,
      scriptId: SCRIPT_ID,
      scriptName: 'csp',
      scanIds: [SCAN],
      state: 'queued',
      input: { config: { a: 1 }, settings: { timeoutMs: null, resources: { cpus: null, memoryMiB: null }, limit: 100 } },
      source: { key: sourceKey(run._id), packSha256: 'a'.repeat(64), packBytes: 123, fileCount: 4 },
      restartedFrom: null,
    })
    expect(snapshots.taken).toEqual([{ userId: OWNER, folder: { script: 'csp' } }])
    expect(s3.copies).toEqual([['tmp/snapshots/x.tar.gz', `script-runs/${run._id}/source.tar.gz`]])
    expect(snapshots.discarded).toEqual(['tmp/snapshots/x.tar.gz'])
    expect(run.secrets?.names).toEqual(['API_TOKEN'])
    expect(JSON.stringify(store.scriptRuns.docs)).not.toContain('tok-123')
    expect(unsealScriptRunSecrets(run)).toEqual({ API_TOKEN: 'tok-123' })
    const [job] = store.jobs.docs as JobDoc[]
    expect(job).toMatchObject({ kind: 'scriptRun', userId: OWNER, subject: { kind: 'scriptRun', id: run._id }, params: { scriptRunId: run._id } })
    expect((store.scriptRuns.docs[0] as ScriptRunDoc).jobId).toBe(job!._id)
    expect(script().latestRun).toMatchObject({ id: run._id, state: 'queued' })
  })

  it("refreshes the script's workspace cache with the snapshot (editor writes never do)", async () => {
    store.scripts.docs[0]!.workspace = { packSha256: 'c'.repeat(64), fileCount: 1, bytes: 10, checkedAt: null, lastSyncSha256: null }
    snapshots.packSha256 = 'b'.repeat(64)
    const run = await startScriptRun(owner, script(), { scans: [SCAN], config: {} }, config)
    expect(script().workspace).toMatchObject({ packSha256: run.source.packSha256, fileCount: 4, bytes: 400, checkedAt: expect.any(Date) })
    expect(run.source.packSha256).toBe('b'.repeat(64))
  })

  it('sets the script pointer before the job exists, so the job’s first state change is never overwritten', async () => {
    const realInsert = store.jobs.insertOne.bind(store.jobs)
    // The in-process runner claims the job as soon as it is created and marks the run building.
    store.jobs.insertOne = async (doc: JobDoc) => {
      const result = await realInsert(doc)
      const subject = store.scriptRuns.docs.find((run) => run._id === doc.subject.id) as ScriptRunDoc
      await updateLatestRunPointer({ ...subject, state: 'building', cancelRequest: null })
      return result
    }
    try {
      await startScriptRun(owner, script(), { scans: [SCAN], config: {} }, config)
    } finally {
      store.jobs.insertOne = realInsert
    }
    expect(script().latestRun).toMatchObject({ state: 'building' })
  })

  it('deletes the run and restores the pointer when its job cannot be created', async () => {
    const earlier = await startScriptRun(owner, script(), { scans: [SCAN], config: {} }, config)
    const realInsert = store.jobs.insertOne.bind(store.jobs)
    store.jobs.insertOne = async () => {
      throw new Error('not primary')
    }
    try {
      await expect(startScriptRun(owner, script(), { scans: [SCAN], config: {} }, config)).rejects.toThrow('not primary')
    } finally {
      store.jobs.insertOne = realInsert
    }
    expect(store.scriptRuns.docs.map((run) => run._id)).toEqual([earlier._id])
    expect(script().latestRun).toMatchObject({ id: earlier._id, state: 'queued' })
  })

  it('refuses another user’s scan with 404, also for an admin caller', async () => {
    await expect(startScriptRun(admin, script(), { scans: [OTHER_SCAN], config: {} }, config)).rejects.toMatchObject({ code: 'notFound' })
    store.scans.docs.push(scan('c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', OWNER, { state: 'deleting' }))
    await expect(startScriptRun(owner, script(), { scans: ['c1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'], config: {} }, config)).rejects.toMatchObject({
      code: 'notFound',
    })
    expect(snapshots.taken).toHaveLength(0)
    expect(store.scriptRuns.docs).toHaveLength(0)
  })

  it('checks the settings caps and the config size before the snapshot', async () => {
    await expect(
      startScriptRun(owner, script(), { scans: [SCAN], config: {}, settings: { timeoutMs: 7_200_000, resources: { cpus: 8, memoryMiB: 8192 } } }, config),
    ).rejects.toMatchObject({
      code: 'validationFailed',
      details: { issues: [{ path: '/settings/timeoutMs' }, { path: '/settings/resources/cpus' }, { path: '/settings/resources/memoryMiB' }] },
    })
    await expect(startScriptRun(owner, script(), { scans: [SCAN], config: { big: 'x'.repeat(2000) } }, config)).rejects.toMatchObject({
      code: 'payloadTooLarge',
    })
    expect(snapshots.taken).toHaveLength(0)
  })

  it('validates the config against the schema described for this pack only, with defaults', async () => {
    store.scripts.docs[0]!.describe = {
      packSha256: 'a'.repeat(64),
      configSchema: { type: 'object', properties: { workers: { type: 'integer', default: 8, maximum: 64 } }, additionalProperties: false },
      resultSchema: null,
      at: new Date(),
    }
    const run = await startScriptRun(owner, script(), { scans: [SCAN], config: {} }, config)
    expect(run.input.config).toEqual({ workers: 8 })
    await expect(startScriptRun(owner, script(), { scans: [SCAN], config: { workers: 100 } }, config)).rejects.toMatchObject({
      code: 'configInvalid',
      details: { issues: [{ path: '/config/workers' }] },
    })
    expect(snapshots.discarded).toHaveLength(2)
    expect(s3.copies).toHaveLength(1)
    snapshots.packSha256 = 'b'.repeat(64)
    const changed = await startScriptRun(owner, script(), { scans: [SCAN], config: { workers: 100 } }, config)
    expect(changed.input.config).toEqual({ workers: 100 })
  })

  it('needs confirm through MCP for a run without a limit', async () => {
    await expect(startScriptRun(agent, script(), { scans: [SCAN], config: {} }, config)).rejects.toMatchObject({
      code: 'confirmationRequired',
      details: { scans: [{ id: SCAN, name: 'scan-a1b2', analyses: 42 }], packSha256: 'a'.repeat(64) },
    })
    expect(store.scriptRuns.docs).toHaveLength(0)
    expect(s3.copies).toHaveLength(0)
    await expect(startScriptRun(agent, script(), { scans: [SCAN], config: {}, settings: { limit: 10 } }, config)).resolves.toMatchObject({ state: 'queued' })
    await expect(startScriptRun(agent, script(), { scans: [SCAN], config: {}, confirm: true }, config)).resolves.toMatchObject({ state: 'queued' })
  })
})

describe('restartScriptRun', () => {
  it('carries the original inputs and secrets with overrides and hands over for a resume', async () => {
    const original = await startScriptRun(
      owner,
      script(),
      { scans: [SCAN], config: { a: 1 }, secrets: { API_TOKEN: 'tok-123' }, settings: { limit: 5, timeoutMs: 60_000 } },
      config,
    )
    await expect(restartScriptRun(owner, original, { resume: true }, config)).rejects.toMatchObject({ code: 'invalidState' })
    await store.scriptRuns.updateOne({ _id: original._id }, { $set: { state: 'failed' } })
    const failed = store.scriptRuns.docs.find((doc) => doc._id === original._id) as ScriptRunDoc
    const restarted = await restartScriptRun(owner, failed, { resume: true, settings: { limit: null, resources: { cpus: 2 } } }, config)
    expect(restarted).toMatchObject({
      scanIds: [SCAN],
      input: { config: { a: 1 }, settings: { timeoutMs: 60_000, resources: { cpus: 2, memoryMiB: null }, limit: null } },
      restartedFrom: { id: original._id, resume: true },
    })
    expect(unsealScriptRunSecrets(restarted)).toEqual({ API_TOKEN: 'tok-123' })
    expect(restarted.secrets?.enc).not.toBe(original.secrets?.enc)
    const again = await restartScriptRun(owner, failed, { resume: false, config: { b: 2 } }, config)
    expect(again).toMatchObject({ input: { config: { b: 2 }, settings: { limit: 5 } }, restartedFrom: { id: original._id, resume: false } })
  })

  it('waits for a cancelled original whose container is still stopping before it resumes it', async () => {
    const original = await startScriptRun(owner, script(), { scans: [SCAN], config: {} }, config)
    const cancelRequest = { at: new Date(), reason: null }
    await store.scriptRuns.updateOne({ _id: original._id }, { $set: { state: 'running', cancelRequest } })
    const pending = store.scriptRuns.docs.find((doc) => doc._id === original._id) as ScriptRunDoc
    // Still stopping after the wait: 409, and nothing was created.
    await expect(restartScriptRun(owner, { ...pending }, { resume: true }, config, 600)).rejects.toMatchObject({ code: 'invalidState' })
    expect(store.scriptRuns.docs).toHaveLength(1)
    // The job settles the cancel during the wait: the resume goes ahead with the settled original.
    setTimeout(() => void store.scriptRuns.updateOne({ _id: original._id }, { $set: { state: 'cancelled', exitCode: 143 } }), 300)
    const resumed = await restartScriptRun(owner, { ...pending }, { resume: true }, config, 5_000)
    expect(resumed.restartedFrom).toEqual({ id: original._id, resume: true })
    // A restart without resume never waits.
    await store.scriptRuns.updateOne({ _id: resumed._id }, { $set: { state: 'running', cancelRequest } })
    const fresh = store.scriptRuns.docs.find((doc) => doc._id === resumed._id) as ScriptRunDoc
    expect((await restartScriptRun(owner, fresh, { resume: false }, config, 0)).restartedFrom).toEqual({ id: resumed._id, resume: false })
  })

  it('counts a resume that waits for a stopping original against the wait budget (429 at once)', async () => {
    const original = await startScriptRun(owner, script(), { scans: [SCAN], config: {} }, config)
    const stopping = { ...original, state: 'running', cancelRequest: { at: new Date(), reason: null } } as ScriptRunDoc
    const held = [reserveWait(OWNER), reserveWait(OWNER)]
    try {
      expect(() => reserveRestartWait(OWNER, stopping, { resume: true }, 0)).toThrow(expect.objectContaining({ code: 'tooManyRequests', statusCode: 429 }))
      // Neither a restart without resume nor a resume of a settled original holds the request.
      expect(reserveRestartWait(OWNER, stopping, { resume: false }, 0)).toBeNull()
      expect(reserveRestartWait(OWNER, { ...original, state: 'failed' } as ScriptRunDoc, { resume: true }, 0)).toBeNull()
    } finally {
      for (const release of held) release()
    }
    const release = reserveRestartWait(OWNER, stopping, { resume: true }, 0)
    expect(release).toBeTypeOf('function')
    release?.()
  })

  it('cancels a run whose script began to be deleted while it was created', async () => {
    const realFindOne = store.scripts.findOne.bind(store.scripts)
    let calls = 0
    store.scripts.findOne = async (...args: Parameters<typeof realFindOne>) => {
      calls++
      store.scripts.docs[0]!.deletingAt = new Date()
      return realFindOne(...args)
    }
    try {
      await expect(startScriptRun(owner, script(), { scans: [SCAN], config: {} }, config)).rejects.toMatchObject({ code: 'notFound' })
    } finally {
      store.scripts.findOne = realFindOne
    }
    expect(calls).toBe(1)
    expect(store.scriptRuns.docs[0]).toMatchObject({ state: 'cancelled', error: { type: 'platform', message: 'the script was deleted' } })
  })

  it('refuses a restart of a script being deleted', async () => {
    const original = await startScriptRun(owner, script(), { scans: [SCAN], config: {} }, config)
    store.scripts.docs[0]!.deletingAt = new Date()
    await expect(restartScriptRun(owner, original, { resume: false }, config)).rejects.toMatchObject({ code: 'notFound' })
  })
})
