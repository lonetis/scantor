import { EventEmitter } from 'node:events'
import { Readable, type Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobDoc, ScriptDoc, ScriptRunDoc, ScriptRunLogChunkDoc } from '../../../server/types/documents'
import { LeaseLostError, type JobContext } from '../../../server/utils/jobs'
import { FakeCollection } from '../../helpers/fake-collection'

// The scriptRun job (docs/scripts.md "Run lifecycle") against a fake Docker daemon and a fake script build: a fresh
// run builds, starts its container with the one conditional update before the start, follows the log and finishes;
// failures of the build and of the script end the run failed; the last log lines are stored before the terminal
// state; a claim of a running run adopts the recorded container and skips the log lines stored before; an
// orchestrator stop detaches; a cancelled run stops and removes its container, and a cancel of a running run (in this
// process or another one) keeps the run `running` until the container stopped, then ends it `cancelled`.

const store = {
  scripts: new FakeCollection<ScriptDoc>('scripts'),
  scriptRuns: new FakeCollection<ScriptRunDoc>('scriptRuns'),
  scriptRunLogs: new FakeCollection<ScriptRunLogChunkDoc>('scriptRunLogs'),
  scans: new FakeCollection('scans'),
  jobs: new FakeCollection<JobDoc>('jobs'),
}
const events: { type: string; data?: Record<string, unknown> }[] = []
const settled: string[] = []
let buildResult: Record<string, unknown> | null = null
/** How long a fake `docker stop` takes (the SIGTERM grace in which the script winds down). */
let stopDelayMs = 0

/** A container of the fake daemon: `exit()` ends its wait and its log stream. */
class FakeContainer {
  status = 'created'
  exitCode = 0
  oomKilled = false
  removed = false
  stopped = false
  started = false
  archived = false
  readonly logRequests: Record<string, unknown>[] = []
  private readonly exited = new EventEmitter()
  private readonly streams: EventEmitter[] = []
  frames: { stream: 'stdout' | 'stderr'; payload: string }[] = []

  constructor(
    readonly id: string,
    readonly spec: Record<string, unknown>,
  ) {}

  exit(code: number) {
    this.status = 'exited'
    this.exitCode = code
    this.exited.emit('exit')
    for (const stream of this.streams) stream.emit('end')
  }

  api() {
    return {
      id: this.id,
      inspect: async () => {
        if (this.removed) throw Object.assign(new Error('gone'), { statusCode: 404 })
        return {
          Id: this.id,
          Name: `/${String(this.spec.name)}`,
          Config: { Labels: this.spec.Labels },
          State: { Status: this.status, ExitCode: this.exitCode, OOMKilled: this.oomKilled },
        }
      },
      putArchive: async (archive: Readable) => {
        archive.destroy()
        this.archived = true
      },
      start: async () => {
        this.started = true
        this.status = 'running'
      },
      wait: (options: { abortSignal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          if (this.status === 'exited') return resolve({ StatusCode: this.exitCode })
          this.exited.once('exit', () => resolve({ StatusCode: this.exitCode }))
          options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      logs: async (options: Record<string, unknown>) => {
        this.logRequests.push(options)
        const stream = new EventEmitter() as EventEmitter & { destroy: () => void; frames: FakeContainer['frames']; exited: () => boolean }
        stream.destroy = () => stream.emit('close')
        stream.frames = this.frames
        stream.exited = () => this.status === 'exited'
        this.streams.push(stream)
        return stream
      },
      stop: async () => {
        this.stopped = true
        await new Promise((resolve) => setTimeout(resolve, stopDelayMs))
        this.frames.push({ stream: 'stderr', payload: '2026-11-08T20:00:09.5Z cancelled by SIGTERM\n' })
        this.exit(143)
      },
      remove: async () => {
        this.removed = true
      },
    }
  }
}

const daemon = {
  containers: new Map<string, FakeContainer>(),
  images: new Set<string>(),
  created: 0,
}

const fakeDocker = {
  getImage: (ref: string) => ({
    inspect: async () => {
      if (!daemon.images.has(ref)) throw Object.assign(new Error('no image'), { statusCode: 404 })
      return {}
    },
    remove: async () => daemon.images.delete(ref),
  }),
  listImages: async () => [],
  createContainer: async (spec: Record<string, unknown>) => {
    const existing = [...daemon.containers.values()].find((container) => container.spec.name === spec.name && !container.removed)
    if (existing) throw Object.assign(new Error('conflict'), { statusCode: 409 })
    const container = new FakeContainer(`cid-${++daemon.created}`, spec)
    daemon.containers.set(container.id, container)
    return container.api()
  },
  getContainer: (idOrName: string) => {
    const container =
      daemon.containers.get(idOrName) ?? [...daemon.containers.values()].find((candidate) => candidate.spec.name === idOrName && !candidate.removed)
    if (!container) {
      const missing = async () => {
        throw Object.assign(new Error('no such container'), { statusCode: 404 })
      }
      return { inspect: missing, remove: missing, stop: missing, wait: missing, logs: missing }
    }
    return container.api()
  },
  modem: {
    // Like Docker: the whole log so far, then the stream ends at once when the container already exited.
    demuxStream: (stream: EventEmitter & { frames: FakeContainer['frames']; exited: () => boolean }, stdout: Writable, stderr: Writable) => {
      setImmediate(() => {
        for (const frame of stream.frames) (frame.stream === 'stdout' ? stdout : stderr).write(Buffer.from(frame.payload))
        if (stream.exited()) setImmediate(() => stream.emit('end'))
      })
    },
  },
}

vi.mock('../../../server/utils/mongo', () => ({
  useCollections: () => Object.fromEntries(Object.entries(store).map(([name, collection]) => [name, collection.asCollection()])),
}))
vi.mock('../../../server/utils/docker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/utils/docker')>()),
  useDocker: () => fakeDocker,
}))
vi.mock('../../../server/utils/s3', () => ({ getObjectStream: async () => Readable.from([Buffer.from('pack')]), deletePrefix: async () => {} }))
vi.mock('../../../server/utils/script-run-tokens', () => ({ mintScriptRunToken: () => 'ssr_token' }))
vi.mock('../../../server/services/pipeline/binary', () => ({ pipelineEnv: () => ({}), runtimeBinary: () => '/dev/null' }))
vi.mock('../../../server/services/pipeline/slots', () => ({ useBuildSlots: () => ({ acquire: async () => () => {} }) }))
vi.mock('../../../server/services/pipeline/script-build', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/pipeline/script-build')>()),
  runScriptBuild: async (options: { onEvent: (event: unknown) => void; tag: string }) => {
    options.onEvent({ v: 1, seq: 1, at: '', phase: 'build', type: 'log', stream: 'build', text: 'Step 1/3 : FROM base' })
    if (buildResult) daemon.images.add(options.tag)
    return { exitCode: buildResult?.ok ? 0 : 2, result: buildResult, timedOut: false, aborted: false, stderrTail: '' }
  },
}))
vi.mock('../../../server/services/script-runs/container', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/script-runs/container')>()),
  runtimeArchive: () => Readable.from([]),
}))
vi.mock('../../../server/services/script-runtime/state', () => ({ flushScriptRunState: async () => {} }))
vi.mock('../../../server/services/script-runtime/outputs', () => ({
  abortPendingOutputs: async (run: { _id: string }) => settled.push(run._id),
}))
vi.mock('../../../server/services/scans/events', () => ({
  writeEvent: async (event: { type: string; data?: Record<string, unknown> }) => events.push(event),
}))
vi.mock('../../../server/utils/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/utils/keys')>()
  const keys = actual.createKeyring('script run job test secret')
  return { ...actual, useKeys: () => keys }
})

const { CANCEL_POLL_MS, failScriptRun, scriptRunJobKind } = await import('../../../server/services/script-runs/job')
const { emptyLogState, readScriptRunLogs } = await import('../../../server/services/script-runs/logs')
const { cancelScriptRunState, countActiveScriptRunJobs, deleteScriptRunsData } = await import('../../../server/services/script-runs/cleanup')
const { toApiScriptRun } = await import('../../../server/services/script-runs/mappers')
const { sealScriptRunSecrets } = await import('../../../server/services/script-runtime/secrets')

const RUN_ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const SCRIPT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const USER = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const PACK = 'f'.repeat(64)
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => quiet }
const config = {
  scriptRunMaxLogBytes: 32 * 1024 ** 2,
  scriptRunTimeoutMs: 3_600_000,
  scriptRunMaxCpus: 4,
  scriptRunMaxMemoryBytes: 8 * 1024 ** 3,
  scriptRunRetentionDays: 30,
  buildTimeoutMs: 600_000,
  internalUrl: 'http://orchestrator:3000',
}

function seedRun(extra: Partial<ScriptRunDoc> = {}): void {
  const now = new Date()
  store.scriptRuns.docs.push({
    _id: RUN_ID,
    userId: USER,
    scriptId: SCRIPT_ID,
    scriptName: 'csp',
    scanIds: [],
    state: 'queued',
    input: { config: {}, settings: { timeoutMs: null, resources: { cpus: null, memoryMiB: null }, limit: null } },
    secrets: null,
    source: { key: `script-runs/${RUN_ID}/source.tar.gz`, packSha256: PACK, packBytes: 1, fileCount: 1 },
    restartedFrom: null,
    image: null,
    entry: null,
    container: null,
    errors: [],
    error: null,
    exitCode: null,
    progress: null,
    checkpoint: null,
    result: null,
    outputs: [],
    log: emptyLogState(),
    jobId: 'job',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    expiresAt: null,
    ...extra,
  } as ScriptRunDoc)
}

function current(): ScriptRunDoc {
  return store.scriptRuns.docs.find((doc) => doc._id === RUN_ID) as ScriptRunDoc
}

function logLines(): { stream: string; text: string }[] {
  return (store.scriptRunLogs.docs as unknown as ScriptRunLogChunkDoc[]).sort((a, b) => a.chunk - b.chunk).flatMap((chunk) => chunk.lines)
}

function context(signal: AbortSignal = new AbortController().signal): JobContext {
  return { job: {} as JobDoc, log: quiet as never, config: config as never, signal, saveCursor: async () => {}, setProgress: async () => {} }
}

async function untilContainer(): Promise<FakeContainer> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const container = [...daemon.containers.values()].find((candidate) => candidate.started && !candidate.removed)
    if (container && current().state === 'running') return container
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('the container never started')
}

const job = { params: { scriptRunId: RUN_ID }, subject: { kind: 'scriptRun', id: RUN_ID } } as unknown as JobDoc

beforeEach(() => {
  for (const collection of Object.values(store)) collection.docs.length = 0
  events.length = 0
  settled.length = 0
  daemon.containers.clear()
  daemon.images.clear()
  daemon.created = 0
  stopDelayMs = 0
  buildResult = {
    ok: true,
    entry: 'main.py',
    defaults: { timeoutMs: null, resources: { cpus: 2, memoryMiB: 512 } },
    image: { ref: `scripts/${SCRIPT_ID}:${PACK}`, id: 'sha256:img', bytes: 1, platform: { os: 'linux', arch: 'arm64' } },
    errors: [],
    warnings: [],
  }
  store.scripts.docs.push({ _id: SCRIPT_ID, latestRun: { id: RUN_ID, state: 'queued', createdAt: new Date(), finishedAt: null } })
})

describe('scriptRun job', () => {
  it('builds, starts the container after marking the run running, follows the log and completes', async () => {
    seedRun({ input: { config: {}, settings: { timeoutMs: null, resources: { cpus: null, memoryMiB: 1024 }, limit: 10 } } })
    const done = scriptRunJobKind.handler(job, context())
    const container = await untilContainer()
    expect(container.archived).toBe(true)
    expect(container.spec).toMatchObject({ Entrypoint: ['/scantor/scantor', 'runtime', 'script', '--entry', 'main.py'], Image: 'sha256:img' })
    expect((container.spec.HostConfig as Record<string, unknown>).NanoCpus).toBe(2e9)
    expect(current()).toMatchObject({
      state: 'running',
      image: { ref: `scripts/${SCRIPT_ID}:${PACK}`, id: 'sha256:img', cached: false },
      entry: 'main.py',
      input: { settings: { timeoutMs: 3_600_000, resources: { cpus: 2, memoryMiB: 1024 }, limit: 10 } },
      container: { id: container.id, name: `scantor-s-${RUN_ID}` },
    })
    expect(current().startedAt).toBeInstanceOf(Date)
    container.frames.push({ stream: 'stdout', payload: '2026-11-08T20:00:00.1Z hello\n' }, { stream: 'stderr', payload: '2026-11-08T20:00:00.2Z warn\n' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    container.exit(0)
    await done
    expect(current()).toMatchObject({ state: 'completed', exitCode: 0, error: null })
    expect(current().expiresAt).toBeInstanceOf(Date)
    expect(container.removed).toBe(true)
    expect(events).toEqual([expect.objectContaining({ type: 'scriptRun.completed', data: expect.objectContaining({ scriptName: 'csp' }) })])
    expect(store.scripts.docs[0]!.latestRun).toMatchObject({ state: 'completed' })
    expect(settled).toEqual([RUN_ID])
    const lines = logLines()
    expect(lines).toEqual(expect.arrayContaining([{ at: expect.any(Date), stream: 'build', text: 'Step 1/3 : FROM base' }]))
    expect(lines.filter((line) => line.stream === 'stdout').map((line) => line.text)).toEqual(['hello'])
    expect(lines.filter((line) => line.stream === 'stderr').map((line) => line.text)).toEqual(['warn'])
    expect(lines.at(-1)).toMatchObject({ stream: 'system', text: 'the script exited with code 0' })
  })

  it('fails with the error the script reported, or a crash with the stderr tail', async () => {
    seedRun()
    const done = scriptRunJobKind.handler(job, context())
    const container = await untilContainer()
    container.frames.push({ stream: 'stderr', payload: '2026-11-08T20:00:00.1Z Traceback: boom\n' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    container.exit(139)
    await done
    expect(current()).toMatchObject({ state: 'failed', exitCode: 139, error: { type: 'crash', message: 'exited with code 139', stack: 'Traceback: boom' } })
    expect(events[0]).toMatchObject({ type: 'scriptRun.failed' })
  })

  it("masks the run's secret values and tokens in the crash's stderr tail like in the log", async () => {
    seedRun({ secrets: sealScriptRunSecrets(RUN_ID, { API_TOKEN: 'TOPSECRET1' }) })
    const done = scriptRunJobKind.handler(job, context())
    const container = await untilContainer()
    const token = `ssr_${RUN_ID}.${'A'.repeat(43)}`
    container.frames.push(
      { stream: 'stderr', payload: '2026-11-08T20:00:00.1Z Traceback: login with TOPSECRET1\n' },
      { stream: 'stderr', payload: `2026-11-08T20:00:00.2Z token ${token} refused\n` },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    container.exit(1)
    await done
    expect(current().error).toEqual({ type: 'crash', message: 'exited with code 1', stack: 'Traceback: login with ***\ntoken ssr_*** refused' })
    expect(
      logLines()
        .filter((line) => line.stream === 'stderr')
        .map((line) => line.text),
    ).toEqual(['Traceback: login with ***', 'token ssr_*** refused'])
  })

  it('fails a run whose build failed with the build errors', async () => {
    buildResult = { ok: false, errors: [{ phase: 'static', file: 'scantor-script.yaml', message: 'name must be csp' }] }
    seedRun()
    await scriptRunJobKind.handler(job, context())
    expect(current()).toMatchObject({ state: 'failed', errors: [{ phase: 'static', file: 'scantor-script.yaml', message: 'name must be csp' }], error: null })
    expect(daemon.containers.size).toBe(0)
  })

  it('fails a run whose manifest defaults exceed the instance limits', async () => {
    buildResult = { ...buildResult, defaults: { timeoutMs: null, resources: { cpus: 16, memoryMiB: 512 } } }
    seedRun()
    await scriptRunJobKind.handler(job, context())
    expect(current()).toMatchObject({ state: 'failed', errors: [{ phase: 'config', file: 'scantor-script.yaml' }] })
  })

  it('adopts the recorded container of a running run and skips the lines stored before', async () => {
    const container = new FakeContainer('cid-adopted', { name: `scantor-s-${RUN_ID}` })
    container.status = 'running'
    daemon.containers.set(container.id, container)
    container.frames.push(
      { stream: 'stdout', payload: '2026-11-08T20:00:00.1Z stored before\n' },
      { stream: 'stdout', payload: '2026-11-08T20:00:00.1Z also stored\n' },
      { stream: 'stdout', payload: '2026-11-08T20:00:00.1Z new at the same time\n' },
      { stream: 'stdout', payload: '2026-11-08T20:00:01Z new\n' },
    )
    seedRun({
      state: 'running',
      image: { ref: 'scripts/x', id: 'sha256:img', cached: false },
      entry: 'main.py',
      container: { id: container.id, name: `scantor-s-${RUN_ID}`, createdAt: new Date() },
      startedAt: new Date(),
      log: { ...emptyLogState(), lines: 2, nextChunk: 1, cursor: { ts: '2026-11-08T20:00:00.1Z', countAtTs: 2 } },
    })
    const done = scriptRunJobKind.handler(job, context())
    await new Promise((resolve) => setTimeout(resolve, 30))
    container.exit(0)
    await done
    expect(container.logRequests[0]).toMatchObject({ follow: true, timestamps: true, since: '1794167999.100000000' })
    expect(
      logLines()
        .filter((line) => line.stream === 'stdout')
        .map((line) => line.text),
    ).toEqual(['new at the same time', 'new'])
    expect(current()).toMatchObject({ state: 'completed' })
  })

  it('detaches at an orchestrator stop and leaves the container running', async () => {
    seedRun()
    const abort = new AbortController()
    const done = scriptRunJobKind.handler(job, context(abort.signal))
    const container = await untilContainer()
    abort.abort(new Error('orchestrator is stopping'))
    await done
    expect(container.removed).toBe(false)
    expect(container.stopped).toBe(false)
    expect(current().state).toBe('running')
  })

  it('stops and removes the container of a cancelled run', async () => {
    seedRun()
    const abort = new AbortController()
    const done = scriptRunJobKind.handler(job, context(abort.signal))
    const container = await untilContainer()
    await store.scriptRuns.updateOne({ _id: RUN_ID }, { $set: { state: 'cancelled' } })
    abort.abort(new LeaseLostError('job'))
    await done
    expect(container.stopped).toBe(true)
    expect(container.removed).toBe(true)
    expect(current()).toMatchObject({ state: 'cancelled', exitCode: 143 })
    expect(logLines().at(-1)).toMatchObject({ stream: 'system', text: 'the script run was cancelled' })
    expect(events).toEqual([])
  })

  it('stores the last log lines before the terminal state', async () => {
    seedRun()
    let atSettle: string[] | null = null
    const findOneAndUpdate = store.scriptRuns.findOneAndUpdate.bind(store.scriptRuns)
    store.scriptRuns.findOneAndUpdate = (async (...args: Parameters<typeof findOneAndUpdate>) => {
      const result = await findOneAndUpdate(...args)
      const state = (args[1] as { $set?: { state?: string } }).$set?.state
      if (result && state && ['completed', 'failed', 'cancelled'].includes(state)) atSettle = logLines().map((line) => line.text)
      return result
    }) as typeof findOneAndUpdate
    const done = scriptRunJobKind.handler(job, context())
    const container = await untilContainer()
    container.frames.push({ stream: 'stderr', payload: '2026-11-08T20:00:00.1Z Traceback (most recent call last): boom\n' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    container.exit(1)
    await done
    // A ?wait woken by the terminal update (and a reader polling the log) sees the traceback and the exit line.
    expect(atSettle).toEqual(expect.arrayContaining(['Traceback (most recent call last): boom', 'the script exited with code 1']))
    expect(current()).toMatchObject({ state: 'failed', log: { lines: atSettle!.length } })
  })

  it('keeps a cancelled running run running until its container stopped, then ends it cancelled', async () => {
    seedRun()
    store.jobs.docs.push({ _id: 'job', kind: 'scriptRun', subject: { kind: 'scriptRun', id: RUN_ID }, state: 'running', active: true })
    stopDelayMs = 200
    const done = scriptRunJobKind.handler(job, context())
    const container = await untilContainer()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const requested = await cancelScriptRunState(RUN_ID, 'the script was deleted', 30)
    expect(toApiScriptRun(requested!)).toMatchObject({ state: 'cancelled', error: { type: 'platform', message: 'the script was deleted' } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // During the SIGTERM grace the run token (state running) still works: the script stores .partial outputs and its
    // checkpoint. The deletion cascades wait, and the run's data stays.
    expect(container.stopped).toBe(true)
    expect(container.removed).toBe(false)
    expect(current()).toMatchObject({ state: 'running', cancelRequest: { reason: 'the script was deleted' } })
    expect(await countActiveScriptRunJobs({ scriptId: SCRIPT_ID })).toBe(1)
    expect(await deleteScriptRunsData({ scriptId: SCRIPT_ID })).toBe(0)
    expect((await readScriptRunLogs(current(), { limit: 1000 })).complete).toBe(false)
    await done
    expect(container.removed).toBe(true)
    expect(current()).toMatchObject({ state: 'cancelled', exitCode: 143, error: { type: 'platform', message: 'the script was deleted' } })
    expect(
      logLines()
        .slice(-2)
        .map((line) => line.text),
    ).toEqual(['cancelled by SIGTERM', 'the script run was cancelled'])
    expect(store.scripts.docs[0]!.latestRun).toMatchObject({ state: 'cancelled' })
    expect(settled).toEqual([RUN_ID])
    expect(events).toEqual([])
  })

  it('notices a cancel made in another orchestrator process', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      seedRun()
      const done = scriptRunJobKind.handler(job, context())
      const container = await untilContainer()
      // Another process wrote the request; nothing aborts this one's in-process signal.
      await store.scriptRuns.updateOne({ _id: RUN_ID }, { $set: { cancelRequest: { at: new Date(), reason: null }, finishedAt: new Date() } })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(container.stopped).toBe(false)
      vi.advanceTimersByTime(CANCEL_POLL_MS)
      await done
      expect(container.stopped).toBe(true)
      expect(container.removed).toBe(true)
      expect(current()).toMatchObject({ state: 'cancelled', exitCode: 143, error: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a run whose script exits while a cancel is pending cancelled', async () => {
    seedRun()
    const done = scriptRunJobKind.handler(job, context())
    const container = await untilContainer()
    await store.scriptRuns.updateOne({ _id: RUN_ID }, { $set: { cancelRequest: { at: new Date(), reason: null }, finishedAt: new Date() } })
    container.exit(0)
    await done
    expect(current()).toMatchObject({ state: 'cancelled', exitCode: 0, error: null })
    expect(events).toEqual([])
  })

  it('stops the recorded container when it claims a run whose cancel is pending', async () => {
    const container = new FakeContainer('cid-pending', { name: `scantor-s-${RUN_ID}` })
    container.status = 'running'
    daemon.containers.set(container.id, container)
    seedRun({
      state: 'running',
      image: { ref: 'scripts/x', id: 'sha256:img', cached: false },
      entry: 'main.py',
      container: { id: container.id, name: `scantor-s-${RUN_ID}`, createdAt: new Date() },
      startedAt: new Date(),
      cancelRequest: { at: new Date(), reason: 'the user was locked out' },
    })
    await scriptRunJobKind.handler(job, context())
    expect(container.stopped).toBe(true)
    expect(container.removed).toBe(true)
    expect(current()).toMatchObject({ state: 'cancelled', exitCode: 143, error: { type: 'platform', message: 'the user was locked out' } })
  })

  it('ends a pending cancel cancelled when the job fails for good', async () => {
    seedRun({
      state: 'running',
      container: { id: 'cid-gone', name: `scantor-s-${RUN_ID}`, createdAt: new Date() },
      cancelRequest: { at: new Date(), reason: null },
    })
    store.jobs.docs.push({ _id: 'job', kind: 'scriptRun', subject: { kind: 'scriptRun', id: RUN_ID }, state: 'queued', active: true })
    expect(await failScriptRun(RUN_ID, 'the job failed', config, quiet)).toBe('cancelled')
    expect(current()).toMatchObject({ state: 'cancelled', error: null, errors: [] })
    expect(store.jobs.docs[0]).toMatchObject({ state: 'cancelled', active: false })
    expect(settled).toEqual([RUN_ID])
    expect(events).toEqual([])
  })
})
