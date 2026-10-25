import { Readable, Writable } from 'node:stream'
import type Docker from 'dockerode'
import { extract as tarExtract } from 'tar-stream'
import type { TestRunState } from '#shared/utils/enums'
import type { BuildErrorDoc, DescriptionDoc, FileRefDoc, JobDoc, TaskDoc, TestRunDoc } from '../../types/documents'
import { useDocker } from '../../utils/docker'
import { ApiError } from '../../utils/errors'
import { FatalJobError, type JobContext, type JobKindDefinition } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import { getObjectStream, putObject, safeName, uploadStream } from '../../utils/s3'
import { maskSecrets } from '../../utils/secrets'
import { findAuthUser } from '../../utils/users'
import { validateConfigs } from '../configs/validate'
import { referencedUploadIds } from '../catalog/estimate'
import { pipelineEnv, runtimeBinary } from '../pipeline/binary'
import { LineSplitter, platformError, type PipelineEvent } from '../pipeline/events'
import { discardTmpSnapshot, snapshotToTmp, type StoredSnapshot } from '../pipeline/snapshot'
import { useBuildSlots } from '../pipeline/slots'
import { MAX_EVENT_LINE_BYTES, runTaskBuild, type TaskBuildOutcome } from '../pipeline/task-build'
import { injectionArchive, type InjectionUpload, localSpec, OUT_DIR, removeContainer, runTestRunContainer, testRunContainerName, testRunContainerSpec } from './container'
import { REQUEST_SECRET_KEY, openRequest, validatedSecretsUpdate } from './create'
import { analysisFromResult, configIssueMessage, type LocalEvent, parseLocalEvent } from './events'
import { cancellationFor, openTestRunChannel, publishTestRunEvent, releaseCancellation } from './live'
import { isTestRunSettled, toApiTestRun, toApiTestRunAnalysis } from './mappers'

// The `testRun` job (docs/tasks.md §11, docs/architecture.md §11.1 step 5): snapshots the live workspace, builds the
// content-addressed draft image `tasks/<taskId>:draft-<packSha256>` (`--skip-check --reuse-existing`, never pushed),
// validates the inputs against the described schemas, runs the runtime in local mode in one `scantor-t-<id>` container
// on scantor-egress, and maps its events to `testRunAnalyses`, the S3 logs, the files and the SSE stream. The whole
// run is bounded by SCANTOR_TEST_RUN_TIMEOUT. Failures end the test run `failed` with BuildErrors; the job itself only
// fails for platform problems outside the run.

const TEST_RUN_WAIT_MS = 10_000
const KILL_GRACE_MS = 30_000
const STORED_LOG_MAX_BYTES = 10 * 1024 ** 2
const STDERR_TAIL_BYTES = 16 * 1024
const NON_TERMINAL: TestRunState[] = ['queued', 'building', 'running']

export function draftImageRef(taskId: string, packSha256: string): string {
  return `tasks/${taskId}:draft-${packSha256}`
}

class TestRunFailure extends Error {
  constructor(
    readonly errors: BuildErrorDoc[],
    readonly state: 'failed' | 'cancelled' = 'failed',
  ) {
    super(errors[0]?.message ?? 'test run failed')
    this.name = 'TestRunFailure'
  }
}

/** NDJSON lines kept for an S3 log object, capped (later lines are dropped after one marker line). */
class StoredLog {
  private readonly lines: string[] = []
  private bytes = 0
  private truncated = false

  append(value: unknown): void {
    const line = JSON.stringify(value)
    if (this.bytes + line.length + 1 > STORED_LOG_MAX_BYTES) {
      if (!this.truncated) {
        this.truncated = true
        this.lines.push(JSON.stringify({ type: 'log', at: new Date().toISOString(), seq: null, stream: 'stderr', text: '[log truncated]' }))
      }
      return
    }
    this.lines.push(line)
    this.bytes += line.length + 1
  }

  async store(key: string): Promise<void> {
    await putObject(key, this.lines.join('\n') + (this.lines.length > 0 ? '\n' : ''), 'application/x-ndjson')
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })
}

async function waitForTestRun(testRunId: string, signal: AbortSignal): Promise<TestRunDoc | null> {
  const deadline = Date.now() + TEST_RUN_WAIT_MS
  for (;;) {
    const doc = await useCollections().testRuns.findOne({ _id: testRunId })
    if (doc || Date.now() > deadline) return doc
    await sleep(200, signal)
  }
}

async function imageExists(docker: Docker, ref: string): Promise<boolean> {
  try {
    await docker.getImage(ref).inspect()
    return true
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return false
    throw error
  }
}

/** One execution of a test run by the job. */
class TestRunExecution {
  private readonly docker = useDocker()
  private readonly buildLog = new StoredLog()
  private readonly runLog = new StoredLog()
  private readonly analyses = new Map<number, FileRefDoc[]>()
  private readonly expectedFiles = new Map<string, { seq: number; file: FileRefDoc }>()
  private readonly errors: BuildErrorDoc[] = []
  private summary = { analyses: 0, succeeded: 0, failed: 0 }
  private endEvent: Extract<LocalEvent, { type: 'end' }> | null = null
  private snapshot: StoredSnapshot | null = null
  private description: DescriptionDoc | null = null

  constructor(
    private doc: TestRunDoc,
    private readonly ctx: JobContext,
    private readonly signal: AbortSignal,
  ) {}

  private get id(): string {
    return this.doc._id
  }

  private remainingMs(): number {
    const started = this.doc.startedAt ?? new Date()
    return this.ctx.config.testRunTimeoutMs - (Date.now() - started.getTime())
  }

  private checkAborted(): void {
    if (this.signal.aborted) throw this.signal.reason ?? new Error('aborted')
  }

  private async setState(state: TestRunState, set: Record<string, unknown> = {}): Promise<void> {
    const now = new Date()
    const updated = await useCollections().testRuns.findOneAndUpdate(
      { _id: this.id, state: { $in: NON_TERMINAL } },
      { $set: { ...set, state, updatedAt: now } },
      { returnDocument: 'after' },
    )
    if (!updated) throw new TestRunFailure([], 'cancelled')
    this.doc = updated
    publishTestRunEvent(this.id, { event: 'state', data: { state } })
  }

  private async update(set: Record<string, unknown>, unset: Record<string, ''> = {}): Promise<void> {
    const updated = await useCollections().testRuns.findOneAndUpdate(
      { _id: this.id },
      { $set: { ...set, updatedAt: new Date() }, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
      { returnDocument: 'after' },
    )
    if (updated) this.doc = updated
  }

  private addError(error: BuildErrorDoc): void {
    this.errors.push(error)
    publishTestRunEvent(this.id, { event: 'error', data: error })
  }

  async run(): Promise<void> {
    const { testRunAnalyses, tasks } = useCollections()
    await testRunAnalyses.deleteMany({ testRunId: this.id })
    await this.setState('building', { startedAt: this.doc.startedAt ?? new Date(), errors: [], summary: this.summary })
    if (this.remainingMs() <= 0) throw new TestRunFailure([platformError(`the test run exceeded ${Math.round(this.ctx.config.testRunTimeoutMs / 1000)} s`)])

    const task = await tasks.findOne({ _id: this.doc.taskId })
    if (!task || task.deletingAt) throw new TestRunFailure([platformError('the task was deleted')], 'cancelled')
    const owner = await findAuthUser(this.doc.userId)
    if (!owner) throw new TestRunFailure([platformError('the owner of the task no longer exists')])

    const outcome = await this.build(task, owner.canRunPrivileged)
    const result = outcome.result
    if (outcome.timedOut) throw new TestRunFailure([platformError(`the test run exceeded ${Math.round(this.ctx.config.testRunTimeoutMs / 1000)} s`)])
    if (outcome.exitCode !== 0 || !result?.ok || !result.description || !result.image) {
      const errors = result?.errors?.length ? result.errors : [platformError(`the task pipeline failed (exit ${outcome.exitCode ?? 'none'})`)]
      throw new TestRunFailure(errors)
    }
    this.description = result.description
    const draft = { ref: this.doc.draftImage?.ref ?? '', digest: result.image.digest ?? result.image.id, cached: this.doc.draftImage?.cached ?? false }
    await this.update({ description: result.description, draftImage: draft })

    const request = openRequest(this.doc) ?? {}
    const timeoutMs = request.timeoutMs ?? result.settingsDefaults?.timeoutMs ?? this.doc.input.timeoutMs
    const secretPaths = result.description.secretPaths
    const maskedInput = {
      ...(request.taskConfig ? { taskConfig: maskSecrets(request.taskConfig, secretPaths.taskConfig) } : {}),
      ...(request.scanConfig ? { scanConfig: maskSecrets(request.scanConfig, secretPaths.scanConfig) } : {}),
      ...(request.analysisConfig ? { analysisConfig: maskSecrets(request.analysisConfig, secretPaths.analysisConfig) } : {}),
      limit: this.doc.input.limit,
      maxAttempts: this.doc.input.maxAttempts,
      timeoutMs,
    }
    let validated: Awaited<ReturnType<typeof validateConfigs>>
    try {
      validated = await validateConfigs(
        result.description,
        { taskConfig: request.taskConfig, scanConfig: request.scanConfig, analysisConfig: request.analysisConfig },
        { collection: 'testRuns', id: this.id },
      )
    } catch (error) {
      await this.update({ input: maskedInput })
      if (error instanceof ApiError && error.code === 'configInvalid') {
        const issues = (error.details?.issues as { path: string; message: string }[] | undefined) ?? [{ path: '', message: error.message }]
        throw new TestRunFailure(issues.map((issue) => ({ phase: 'config', message: configIssueMessage(issue) })))
      }
      throw error
    }
    // `input` keeps the configs as requested (secrets masked); the effective configs only reach the container. The
    // per-pointer secrets sit next to `secrets.request`, which stays until the run is terminal: an attempt that is
    // restarted (a lost lease, an orchestrator stop) validates the requested configs again from scratch.
    const secretsUpdate = validatedSecretsUpdate(validated.secrets)
    await this.update({ input: maskedInput, ...secretsUpdate.set }, secretsUpdate.unset)

    const uploads = await this.uploads(result.description, validated.effective)
    this.checkAborted()
    const remaining = this.remainingMs()
    if (remaining <= 0) throw new TestRunFailure([platformError(`the test run exceeded ${Math.round(this.ctx.config.testRunTimeoutMs / 1000)} s`)])
    await this.setState('running')
    const settings = result.settingsDefaults
    const spec = localSpec(
      {
        testRunId: this.id,
        entry: typeof result.manifest?.entry === 'string' ? result.manifest.entry : '',
        taskConfig: validated.effective.taskConfig,
        scanConfig: validated.effective.analysisConfig ? null : validated.effective.scanConfig,
        analysisConfig: validated.effective.analysisConfig ?? null,
        limit: this.doc.input.limit,
        timeoutMs,
        maxAttempts: this.doc.input.maxAttempts,
        backoff: settings?.backoff ?? { initialMs: 5000, factor: 2, maxMs: 600_000, jitter: true },
        maxAnalysesPerProcess: settings?.maxAnalysesPerProcess ?? 1000,
        totalTimeoutMs: remaining,
        uploads: Object.fromEntries(uploads.map((upload) => [upload.id, { sha256: upload.sha256 }])),
      },
      this.ctx.config,
    )
    await this.runContainer(result.image.id || draft.ref, settings?.resources ?? { cpus: 1, memoryMiB: 512 }, spec, uploads, remaining)
  }

  /** Snapshot → `scantor task build -` of the draft image (static checks and describe always run). */
  private async build(task: TaskDoc, allowPrivileged: boolean): Promise<TaskBuildOutcome> {
    this.snapshot = await snapshotToTmp(task.userId, task.name, this.signal)
    const ref = draftImageRef(task._id, this.snapshot.packSha256)
    const cached = await imageExists(this.docker, ref)
    await this.update({ packSha256: this.snapshot.packSha256, draftImage: { ref, digest: '', cached } })
    const release = await useBuildSlots().acquire({ signal: this.signal })
    try {
      const input = await getObjectStream(this.snapshot.tmpKey)
      return await runTaskBuild({
        input,
        tag: ref,
        expectName: task.name,
        allowPrivileged,
        skipCheck: true,
        reuseExisting: true,
        env: pipelineEnv(this.ctx.config),
        onEvent: (event) => this.onPipelineEvent(event),
        timeoutMs: Math.max(1000, this.remainingMs()),
        signal: this.signal,
        log: this.ctx.log,
      })
    } finally {
      release()
      await discardTmpSnapshot(this.snapshot)
    }
  }

  private onPipelineEvent(event: PipelineEvent): void {
    this.buildLog.append(event)
    if (event.type === 'log' && event.text !== undefined) {
      publishTestRunEvent(this.id, { event: 'log', data: { seq: null, stream: 'build', text: event.text, at: event.at } })
    } else if (event.type === 'error' && event.error) {
      publishTestRunEvent(this.id, { event: 'error', data: event.error })
    }
  }

  /** Uploads referenced by the effective configs (docs/tasks.md §11.3): owned by the test run's user, copied into the container. */
  private async uploads(description: DescriptionDoc, effective: { taskConfig: Record<string, unknown>; scanConfig: Record<string, unknown> }): Promise<(InjectionUpload & { sha256: string })[]> {
    const ids = new Set([
      ...referencedUploadIds(effective.taskConfig, description.uploadPaths.taskConfig ?? []),
      ...referencedUploadIds(effective.scanConfig, description.uploadPaths.scanConfig ?? []),
    ])
    if (ids.size === 0) return []
    const docs = await useCollections().uploads.find({ _id: { $in: [...ids] }, userId: this.doc.userId }).toArray()
    const missing = [...ids].filter((id) => !docs.some((doc) => doc._id === id))
    if (missing.length > 0) throw new TestRunFailure(missing.map((id) => ({ phase: 'config', message: `upload ${id} not found` })))
    return docs.map((doc) => ({ id: doc._id, bytes: doc.bytes, sha256: doc.sha256, open: () => getObjectStream(doc.key) }))
  }

  private async runContainer(
    image: string,
    resources: { cpus: number; memoryMiB: number },
    spec: unknown,
    uploads: InjectionUpload[],
    remainingMs: number,
  ): Promise<void> {
    const lines = new LineSplitter(MAX_EVENT_LINE_BYTES, (length) => this.ctx.log.warn('dropped an oversized local-mode event', { bytes: length }))
    let stderrTail = ''
    const stderr = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
        callback()
      },
    })
    let chain = Promise.resolve()
    lines.on('data', (line: string) => {
      const event = parseLocalEvent(line)
      if (!event) return
      chain = chain.then(() => this.onLocalEvent(event)).catch((error: unknown) => this.ctx.log.error('handling a local-mode event failed', { err: error }))
    })
    // Rejects when the run is cancelled before the container started; a started container is killed and drained below.
    const { container, exitCode, killed, outputEnded } = await runTestRunContainer({
      docker: this.docker,
      create: testRunContainerSpec({ testRunId: this.id, userId: this.doc.userId, image, resources, capAdd: this.ctx.config.workerCapAdd }),
      archive: () => injectionArchive(runtimeBinary(), spec, uploads),
      stdout: lines,
      stderr,
      killAfterMs: remainingMs + KILL_GRACE_MS,
      signal: this.signal,
      log: this.ctx.log,
    })
    await Promise.race([outputEnded, new Promise((resolve) => setTimeout(resolve, 5000))])
    lines.end()
    await chain
    this.checkAborted()
    await this.collectFiles(container)
    if (killed === 'timeout') throw new TestRunFailure([...this.errors, platformError(`the test run exceeded ${Math.round(this.ctx.config.testRunTimeoutMs / 1000)} s`)])
    if (!this.endEvent) {
      const detail = stderrTail.trim().split('\n').at(-1) ?? ''
      throw new TestRunFailure([...this.errors, platformError(`the test-run container exited with code ${exitCode} before the run ended${detail ? `: ${detail}` : ''}`)])
    }
  }

  private async onLocalEvent(event: LocalEvent): Promise<void> {
    this.runLog.append(event)
    switch (event.type) {
      case 'log':
        publishTestRunEvent(this.id, { event: 'log', data: { seq: event.seq ?? null, stream: event.stream === 'stderr' ? 'stderr' : 'stdout', text: String(event.text ?? ''), at: event.at } })
        return
      case 'result': {
        const doc = analysisFromResult(event, {
          testRunId: this.id,
          userId: this.doc.userId,
          expiresAt: this.doc.expiresAt,
          secretPaths: { analysisConfig: this.description?.secretPaths.analysisConfig ?? [], result: this.description?.secretPaths.result ?? [] },
          now: new Date(),
        })
        await useCollections().testRunAnalyses.replaceOne({ _id: doc._id }, doc, { upsert: true })
        this.analyses.set(event.seq, doc.files)
        for (const file of event.files ?? []) {
          const ref = doc.files.find((candidate) => candidate.id === file.id)
          if (ref && typeof file.path === 'string') this.expectedFiles.set(file.path, { seq: event.seq, file: ref })
        }
        this.summary = {
          analyses: this.summary.analyses + 1,
          succeeded: this.summary.succeeded + (doc.status === 'succeeded' ? 1 : 0),
          failed: this.summary.failed + (doc.status === 'failed' ? 1 : 0),
        }
        await this.update({ summary: this.summary })
        publishTestRunEvent(this.id, { event: 'analysis', data: toApiTestRunAnalysis(doc) })
        return
      }
      case 'error':
        this.addError({ phase: 'schedule', message: String(event.error?.message ?? 'local run failed').slice(0, 4096) })
        return
      case 'end':
        this.endEvent = event
        if (event.summary) this.summary = { analyses: event.summary.analyses, succeeded: event.summary.succeeded, failed: event.summary.failed }
        return
      default:
        return
    }
  }

  /** CopyFromContainer of /scantor/out: uploads the files the result events listed to `test-runs/<id>/files/…`. */
  private async collectFiles(container: Docker.Container): Promise<void> {
    if (this.expectedFiles.size === 0) return
    const archive = (await container.getArchive({ path: OUT_DIR })) as NodeJS.ReadableStream
    const extractor = tarExtract()
    const maxBytes = this.ctx.config.maxFileBytes
    const done = new Promise<void>((resolve, reject) => {
      extractor.on('entry', (header, entryStream, next) => {
        const path = header.name.replace(/^out\//, '').replace(/^\.\//, '')
        const expected = header.type === 'file' ? this.expectedFiles.get(path) : undefined
        if (!expected || header.size > maxBytes) {
          entryStream.on('end', () => next())
          entryStream.resume()
          return
        }
        const key = `test-runs/${this.id}/files/${expected.seq}/${expected.file.id}/${safeName(expected.file.name)}`
        // tar-stream entries are streamx streams, which the S3 uploader does not accept as a body.
        const body = Readable.from(entryStream as AsyncIterable<Buffer>, { objectMode: false })
        uploadStream(key, body, expected.file.contentType || 'application/octet-stream', { 'file-id': expected.file.id, name: encodeURIComponent(expected.file.name) })
          .then(() => {
            expected.file.key = key
            next()
          })
          .catch((error: unknown) => next(error as Error))
      })
      extractor.on('finish', resolve)
      extractor.on('error', reject)
    })
    ;(archive as unknown as NodeJS.ReadableStream).pipe(extractor as unknown as NodeJS.WritableStream)
    await done
    const { testRunAnalyses } = useCollections()
    for (const [seq, files] of this.analyses) {
      if (files.some((file) => file.key)) await testRunAnalyses.updateOne({ _id: `${this.id}-${seq}` }, { $set: { files, updatedAt: new Date() } })
    }
  }

  /** Final state, logs and the `end` event. */
  async finish(failure: TestRunFailure | null): Promise<void> {
    const { testRuns } = useCollections()
    let state: TestRunState = 'completed'
    let errors = this.errors
    if (failure) {
      state = failure.state
      errors = failure.errors.length > 0 ? failure.errors : this.errors
    } else if (this.endEvent && (this.endEvent.reason === 'scheduleFailed' || this.endEvent.reason === 'startFailed' || this.endEvent.reason === 'timeout' || this.endEvent.reason === 'interrupted')) {
      state = 'failed'
      if (this.endEvent.reason === 'timeout') errors = [...errors, platformError(`the test run exceeded ${Math.round(this.ctx.config.testRunTimeoutMs / 1000)} s`)]
      if (errors.length === 0) errors = [{ phase: 'schedule', message: `the local run ended with ${this.endEvent.reason}` }]
    }
    await Promise.all([
      this.buildLog.store(this.doc.buildLogKey).catch((error: unknown) => this.ctx.log.warn('storing the test-run build log failed', { err: error })),
      this.runLog.store(this.doc.logKey).catch((error: unknown) => this.ctx.log.warn('storing the test-run log failed', { err: error })),
    ])
    const now = new Date()
    await testRuns.updateOne(
      { _id: this.id, state: { $in: NON_TERMINAL } },
      { $set: { state, errors: errors.slice(0, 200), summary: this.summary, finishedAt: now, updatedAt: now }, $unset: { [`secrets.${REQUEST_SECRET_KEY}`]: '' } },
    )
    // A run cancelled meanwhile keeps `cancelled`; the stream reports the stored final state.
    const final = await testRuns.findOne({ _id: this.id })
    if (!final) return
    publishTestRunEvent(this.id, { event: 'state', data: { state: final.state } })
    publishTestRunEvent(this.id, { event: 'end', data: toApiTestRun(final) })
  }

  /** Removes the temporary snapshot and the container (also one created but never started). */
  async cleanup(): Promise<void> {
    if (this.snapshot) await discardTmpSnapshot(this.snapshot)
    await removeContainer(this.docker, testRunContainerName(this.id)).catch((error: unknown) =>
      this.ctx.log.warn('removing the test-run container failed', { testRunId: this.id, err: error }),
    )
  }
}

async function runTestRun(job: JobDoc, ctx: JobContext): Promise<void> {
  const testRunId = String(job.params.testRunId ?? job.subject.id)
  const doc = await waitForTestRun(testRunId, ctx.signal)
  if (!doc) throw new FatalJobError('notFound', `test run ${testRunId} does not exist`)
  if (isTestRunSettled(doc)) return
  const cancel = cancellationFor(testRunId)
  const signal = AbortSignal.any([ctx.signal, cancel.signal])
  openTestRunChannel(testRunId)
  const execution = new TestRunExecution(doc, ctx, signal)
  try {
    try {
      await execution.run()
      await execution.finish(null)
    } catch (error) {
      if (cancel.signal.aborted) {
        await execution.finish(new TestRunFailure([], 'cancelled'))
        return
      }
      // Stopped or lease lost: the runner requeues the job (or another runner owns it); the run restarts from scratch.
      if (ctx.signal.aborted) return
      if (error instanceof TestRunFailure) {
        await execution.finish(error)
        return
      }
      ctx.log.error('test run failed', { testRunId, err: error })
      const message = error instanceof ApiError ? error.message : 'internal error'
      await execution.finish(new TestRunFailure([platformError(message)]))
    }
  } finally {
    releaseCancellation(testRunId, cancel)
    await execution.cleanup()
  }
}

export const testRunJobKind: JobKindDefinition = {
  component: 'api',
  concurrency: (config) => config.testRunConcurrency,
  maxAttempts: 2,
  backoff: { initialMs: 5000, maxMs: 30_000 },
  handler: runTestRun,
  async onFailed(job, error) {
    const testRunId = String(job.params.testRunId ?? job.subject.id)
    const now = new Date()
    await useCollections().testRuns.updateOne(
      { _id: testRunId, state: { $in: NON_TERMINAL } },
      { $set: { state: 'failed', errors: [platformError(error.message)], finishedAt: now, updatedAt: now }, $unset: { [`secrets.${REQUEST_SECRET_KEY}`]: '' } },
    )
  },
}
