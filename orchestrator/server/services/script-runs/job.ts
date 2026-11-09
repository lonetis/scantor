import { Writable } from 'node:stream'
import type Docker from 'dockerode'
import { ACTIVE_SCRIPT_RUN_STATES, type ScriptRunState } from '#shared/utils/enums'
import type { BuildErrorDoc, JobDoc, ScriptRunDoc, ScriptRunErrorDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { useDocker } from '../../utils/docker'
import { FatalJobError, type JobContext, type JobKindDefinition, LeaseLostError } from '../../utils/jobs'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { getObjectStream } from '../../utils/s3'
import { mintScriptRunToken } from '../../utils/script-run-tokens'
import { pipelineEnv, runtimeBinary } from '../pipeline/binary'
import { platformError, type PipelineEvent } from '../pipeline/events'
import { runScriptBuild, scriptImageRef } from '../pipeline/script-build'
import { useBuildSlots } from '../pipeline/slots'
import { abortPendingOutputs } from '../script-runtime/outputs'
import { maskableSecrets, maskScriptRunText, unsealScriptRunSecrets } from '../script-runtime/secrets'
import { flushScriptRunState } from '../script-runtime/state'
import { cancelQueuedScriptRunJob, expiresAtOf, removeScriptImages, settleCancelRequest } from './cleanup'
import {
  inspectContainer,
  isScriptRunContainer,
  removeContainerById,
  runtimeArchive,
  scriptRunContainerName,
  scriptRunContainerSpec,
  stopContainerById,
} from './container'
import { scriptRunEvent } from './events'
import { cancellationFor, releaseCancellation } from './live'
import { LOG_LINE_MAX_BYTES, ScriptRunLogWriter, sinceOf, timestampNanos } from './logs'
import { updateLatestRunPointer } from './pointer'
import { settingsIssues } from './start'

// The `scriptRun` job (docs/scripts.md "Run lifecycle"; api component, SCANTOR_SCRIPT_RUN_CONCURRENCY slots per
// process and SCANTOR_SCRIPT_RUN_CONCURRENCY_PER_USER per user, 10 attempts, attempts refunded at an orchestrator
// stop). It is resumable: each claim continues where the run is.
//   build   (state building) `scantor script build -` of the stored source into `scripts/<scriptId>:<packSha256>`
//           (skipped when the recorded image still exists), build events into the log, the manifest defaults merged
//           into the settings (explicit > manifest > SCANTOR_SCRIPT_RUN_TIMEOUT) and the caps checked again
//   start   the container `scantor-s-<id>`, the runtime injected, then ONE conditional update building → running
//           (with the container and startedAt) before the start, because the run token is valid only while running
//   run     the container's log followed into the run log, the exit awaited, the total timeout enforced from startedAt
//   finish  exit 0 → completed; else failed with the error the script reported, a crash, an OOM kill or the timeout;
//           pending outputs aborted, the pending progress and checkpoint written, the container removed by id
// An orchestrator stop detaches: the log is flushed and the container keeps running. The next claim adopts it by its
// recorded id (a lost lease of a cancelled run stops it). A container found by name is used only with this run's
// managed labels.
// Cancellation: the execution watches its run (the in-process signal at once, the document every CANCEL_POLL_MS for a
// cancel in another process); a cancelled run's container is stopped with the 60 s SIGTERM grace, its last lines and
// outputs settled, and a pending cancel request ends `cancelled` (cleanup.ts settleCancelRequest). The job itself is
// never cancelled for this, so it stays active until everything is stored. Every terminal update follows a flush of
// the log, so a `?wait` and the log reader see the last lines with the final state.

const NON_TERMINAL: ScriptRunState[] = [...ACTIVE_SCRIPT_RUN_STATES]
const STDERR_TAIL_LINES = 20
const STDERR_TAIL_BYTES = 8 * 1024
/** Longest timer (setTimeout overflows above 2^31 − 1 ms); longer timeouts re-arm. */
const MAX_TIMER_MS = 2_000_000_000
const WAIT_RETRY_MS = 5000
const LOG_DRAIN_MS = 10_000
/** How often an execution checks its run for a cancel made in another orchestrator process. */
export const CANCEL_POLL_MS = 5000
/** How long the follow stream may take to deliver the last lines after the container exited. */
const LOG_END_GRACE_MS = 5000
/** Wall-clock safety net of the script build above SCANTOR_BUILD_TIMEOUT. */
const BUILD_DRIVER_MARGIN_MS = 5 * 60_000

/** A failure that ends the run `failed` (BuildErrors and/or the run error). */
class RunFailure extends Error {
  constructor(
    readonly errors: BuildErrorDoc[],
    readonly error: ScriptRunErrorDoc | null = null,
  ) {
    super(error?.message ?? errors[0]?.message ?? 'script run failed')
    this.name = 'RunFailure'
  }
}

/** The run left the active states while this execution worked (a cancel, or another runner finished it). */
class RunSettled extends Error {
  constructor() {
    super('the script run is no longer active')
    this.name = 'RunSettled'
  }
}

export interface ContainerExit {
  exitCode: number
  oomKilled: boolean
  timedOut: boolean
}

function platformFailure(message: string): RunFailure {
  return new RunFailure([platformError(message)], { type: 'platform', message: message.slice(0, 16 * 1024) })
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

/**
 * The final state of a run whose container exited: exit 0 → completed; the timeout, an OOM kill, the error the script
 * reported through scriptRuntimeFinish, or else a crash with the exit code and the last stderr lines → failed.
 */
export function exitOutcome(
  exit: ContainerExit,
  reported: ScriptRunErrorDoc | null,
  stderrTail: string | undefined,
  timeoutMs: number,
): { state: ScriptRunState; error: ScriptRunErrorDoc | null } {
  if (exit.timedOut) return { state: 'failed', error: { type: 'timeout', message: `the script run exceeded its timeout of ${formatDuration(timeoutMs)}` } }
  if (exit.oomKilled) return { state: 'failed', error: { type: 'crash', message: 'killed: out of memory' } }
  if (exit.exitCode === 0) return { state: 'completed', error: null }
  return { state: 'failed', error: reported ?? { type: 'crash', message: `exited with code ${exit.exitCode}`, ...(stderrTail ? { stack: stderrTail } : {}) } }
}

/** The `stack` of a crash: the remembered stderr lines, masked (redaction rules, the run's secrets), then cut to the tail. */
export function stderrSummaryOf(lines: readonly string[], secrets: readonly string[]): string | undefined {
  const text = maskScriptRunText(lines.join('\n'), secrets)
  if (!text) return undefined
  return text.length > STDERR_TAIL_BYTES ? text.slice(-STDERR_TAIL_BYTES) : text
}

/** Splits the demultiplexed frames of one stream (`<RFC3339Nano> <text>`) into lines, joining Docker's partial frames. */
export class FrameAssembler {
  private buffer = ''
  /** the timestamp of the last frame the buffer holds a part of */
  private bufferTs: string | undefined
  private discarding = false

  constructor(private readonly emit: (text: string, ts: string | undefined) => void) {}

  /** One frame; `ts` is passed with the first line it completes (the cursor counts frames). */
  frame(text: string, ts: string | undefined): void {
    let first = true
    let rest = text
    for (;;) {
      const newline = rest.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer + rest.slice(0, newline)
      rest = rest.slice(newline + 1)
      this.buffer = ''
      this.bufferTs = undefined
      if (this.discarding) {
        this.discarding = false
      } else {
        this.emit(line.endsWith('\r') ? line.slice(0, -1) : line, first ? ts : undefined)
        first = false
      }
    }
    if (this.discarding) return
    if (rest.length > 0) {
      this.buffer += rest
      this.bufferTs = ts
    }
    // A line without end: store its first 16 KiB (cut with a marker) and skip the rest of it.
    if (Buffer.byteLength(this.buffer, 'utf8') > 2 * LOG_LINE_MAX_BYTES) {
      this.emit(this.buffer, ts)
      this.buffer = ''
      this.bufferTs = undefined
      this.discarding = true
    }
  }

  /** The stream ended: a last line without a newline is stored with the timestamp of its last frame. */
  end(): void {
    if (this.buffer.length > 0 && !this.discarding) this.emit(this.buffer, this.bufferTs)
    this.buffer = ''
    this.bufferTs = undefined
    this.discarding = false
  }
}

/** One claim of a script run by its job. */
class ScriptRunExecution {
  private readonly docker = useDocker()
  private readonly writer: ScriptRunLogWriter
  private readonly cancel: AbortController
  private readonly signal: AbortSignal
  private readonly stderrTail: string[] = []
  /** the run's secret values, masked in the log and in the crash's stderr tail */
  private readonly secrets: string[]
  private containerId: string | null
  private watchTimer: NodeJS.Timeout | null = null

  constructor(
    private doc: ScriptRunDoc,
    private readonly ctx: JobContext,
  ) {
    let secrets: string[] = []
    try {
      secrets = Object.values(unsealScriptRunSecrets(doc))
    } catch (error) {
      ctx.log.warn('the secrets of a script run do not open; the log is not masked with them', { scriptRunId: doc._id, err: error })
    }
    this.secrets = maskableSecrets(secrets)
    this.writer = new ScriptRunLogWriter(doc._id, doc.log, { maxLogBytes: ctx.config.scriptRunMaxLogBytes, secrets: this.secrets, log: ctx.log })
    this.cancel = cancellationFor(doc._id)
    this.signal = AbortSignal.any([ctx.signal, this.cancel.signal])
    this.containerId = doc.container?.id ?? null
  }

  private get id(): string {
    return this.doc._id
  }

  private get log(): Logger {
    return this.ctx.log
  }

  private system(text: string): void {
    this.writer.append('system', text)
  }

  async run(): Promise<void> {
    await this.writer.resume()
    this.writer.start()
    this.watchCancellation()
    try {
      try {
        if (this.doc.cancelRequest) throw new RunSettled()
        if (this.doc.state === 'queued' || this.doc.state === 'building') {
          await this.build()
          await this.startContainer(false)
        }
        if (this.doc.state !== 'running') throw new RunSettled()
        const exit = await this.supervise()
        await this.finish(exit)
      } catch (error) {
        if (error instanceof RunFailure) {
          await this.fail(error)
          return
        }
        if (error instanceof RunSettled || this.signal.aborted) {
          await this.interrupted()
          return
        }
        throw error
      }
    } finally {
      this.stopWatching()
      await this.writer.close()
      releaseCancellation(this.id, this.cancel)
    }
  }

  /** Checks the run every CANCEL_POLL_MS: a cancel (or the run's deletion) in another process fires the cancellation. */
  private watchCancellation(): void {
    this.watchTimer = setInterval(() => void this.checkCancelled(), CANCEL_POLL_MS)
    this.watchTimer.unref?.()
  }

  private stopWatching(): void {
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.watchTimer = null
  }

  private async checkCancelled(): Promise<void> {
    if (this.cancel.signal.aborted) return
    try {
      const current = await useCollections().scriptRuns.findOne({ _id: this.id }, { projection: { state: 1, cancelRequest: 1 } })
      if (!current || current.state === 'cancelled' || current.cancelRequest) this.cancel.abort(new Error('the script run was cancelled'))
    } catch (error) {
      this.log.debug('checking the script run for a cancel failed', { scriptRunId: this.id, err: error })
    }
  }

  /** Why the run stopped being ours: cancelled (stop the container) or detached (leave it running). */
  private async interruptedBy(): Promise<'cancelled' | 'detach'> {
    if (this.cancel.signal.aborted) return 'cancelled'
    // An orchestrator stop detaches at once (stopping takes up to a minute): the next claim adopts the container and
    // handles a cancel that is pending.
    if (this.ctx.signal.aborted && !(this.ctx.signal.reason instanceof LeaseLostError)) return 'detach'
    const current = await useCollections().scriptRuns.findOne({ _id: this.id }, { projection: { state: 1, cancelRequest: 1 } })
    // Cancelled (or deleted): stop the container. Otherwise a lost lease (another runner owns the run now) or a run
    // another runner settled: leave everything as it is.
    return !current || current.state === 'cancelled' || current.cancelRequest ? 'cancelled' : 'detach'
  }

  private async interrupted(): Promise<void> {
    if ((await this.interruptedBy()) === 'detach') {
      this.log.info('detached from the script run; its container keeps running', { scriptRunId: this.id, containerId: this.containerId })
      return
    }
    await this.stopCancelled()
  }

  // ── build ─────────────────────────────────────────────────────────────────

  private async setBuilding(): Promise<void> {
    const wasQueued = this.doc.state === 'queued'
    const updated = await useCollections().scriptRuns.findOneAndUpdate(
      { _id: this.id, state: { $in: ['queued', 'building'] } },
      { $set: { state: 'building', updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    if (!updated) throw new RunSettled()
    this.doc = updated
    await updateLatestRunPointer(updated)
    if (!wasQueued) return
    const scans = await useCollections()
      .scans.find({ _id: { $in: this.doc.scanIds } }, { projection: { name: 1, state: 1 } })
      .toArray()
    for (const scan of scans) {
      if (!['completed', 'failed', 'cancelled'].includes(scan.state)) {
        this.system(`scan ${scan.name ?? scan._id} is ${scan.state}: the run reads the analyses stored so far`)
      }
    }
  }

  private onBuildEvent(event: PipelineEvent): void {
    if (event.type === 'log' && event.text !== undefined) {
      for (const line of event.text.split('\n')) this.writer.append('build', line)
    } else if (event.type === 'error' && event.error) {
      const where = event.error.file ? `${event.error.file}${event.error.line ? `:${event.error.line}` : ''}: ` : ''
      this.writer.append('build', `error (${event.error.phase}): ${where}${event.error.message}`)
    }
  }

  private async build(): Promise<void> {
    await this.setBuilding()
    if (this.doc.image?.id && this.doc.entry && (await imageExists(this.docker, this.doc.image.id))) {
      this.system(`using the image built before (${this.doc.image.ref})`)
      return
    }
    const config = this.ctx.config
    const ref = scriptImageRef(this.doc.scriptId, this.doc.source.packSha256)
    const cached = await imageExists(this.docker, ref)
    this.system(cached ? `building ${ref} (an image of this code exists; unchanged layers are reused)` : `building ${ref}`)
    const release = await useBuildSlots().acquire({ signal: this.signal })
    let outcome: Awaited<ReturnType<typeof runScriptBuild>>
    try {
      this.signal.throwIfAborted()
      const input = await getObjectStream(this.doc.source.key)
      outcome = await runScriptBuild({
        input,
        tag: ref,
        expectName: this.doc.scriptName,
        reuseExisting: true,
        env: pipelineEnv(config),
        onEvent: (event) => this.onBuildEvent(event),
        timeoutMs: config.buildTimeoutMs + BUILD_DRIVER_MARGIN_MS,
        signal: this.signal,
        log: this.log,
      })
    } finally {
      release()
    }
    this.signal.throwIfAborted()
    const result = outcome.result
    if (outcome.timedOut) throw platformFailure(`the script build exceeded ${formatDuration(config.buildTimeoutMs)}`)
    if (outcome.exitCode !== 0 || !result?.ok || !result.image || !result.entry) {
      const errors = result?.errors?.length
        ? result.errors
        : [
            platformError(
              `the script build failed (exit ${outcome.exitCode ?? 'none'})${outcome.stderrTail ? `: ${outcome.stderrTail.trim().split('\n').at(-1)}` : ''}`,
            ),
          ]
      const platform = errors.find((error) => error.phase === 'platform')
      throw new RunFailure(errors, platform ? { type: 'platform', message: platform.message } : null)
    }
    const explicit = this.doc.input.settings
    const settings = {
      timeoutMs: explicit.timeoutMs ?? result.defaults?.timeoutMs ?? config.scriptRunTimeoutMs,
      resources: {
        cpus: explicit.resources.cpus ?? result.defaults?.resources.cpus ?? 1,
        memoryMiB: explicit.resources.memoryMiB ?? result.defaults?.resources.memoryMiB ?? 1024,
      },
      limit: explicit.limit,
    }
    const issues = settingsIssues(settings, config)
    if (issues.length > 0) {
      throw new RunFailure(
        issues.map((issue) => ({
          phase: 'config',
          file: 'scantor-script.yaml',
          message: `defaults${issue.path.replace(/^\/settings/, '').replaceAll('/', '.')} ${issue.message}`,
        })),
      )
    }
    const updated = await useCollections().scriptRuns.findOneAndUpdate(
      { _id: this.id, state: 'building' },
      { $set: { image: { ref, id: result.image.id, cached }, entry: result.entry, 'input.settings': settings, updatedAt: new Date() } },
      { returnDocument: 'after' },
    )
    if (!updated) throw new RunSettled()
    this.doc = updated
    this.system(`built ${ref}`)
    await removeScriptImages(this.doc.scriptId, ref).catch((error: unknown) =>
      this.log.warn('removing older script images failed', { scriptId: this.doc.scriptId, err: error }),
    )
  }

  // ── start ─────────────────────────────────────────────────────────────────

  /** Creates and starts the container; `recreate` replaces a container of a running run that never started. */
  private async startContainer(recreate: boolean): Promise<void> {
    const { image, entry } = this.doc
    if (!image || !entry) throw platformFailure('the script run has no built image')
    const settings = this.doc.input.settings
    const spec = scriptRunContainerSpec({
      scriptRunId: this.id,
      userId: this.doc.userId,
      image: image.id,
      entry,
      resources: { cpus: settings.resources.cpus ?? 1, memoryMiB: settings.resources.memoryMiB ?? 1024 },
      url: this.ctx.config.internalUrl,
      token: mintScriptRunToken(this.doc),
    })
    this.signal.throwIfAborted()
    let container: Docker.Container
    try {
      container = await this.docker.createContainer(spec)
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 409) throw platformFailure(`creating the container failed: ${(error as Error).message}`)
      const existing = await inspectContainer(this.docker, spec.name)
      if (!existing || !isScriptRunContainer(this.id, existing.name, existing.labels)) {
        throw platformFailure(`a container named ${spec.name} exists that is not this run's`)
      }
      if (existing.status !== 'created') {
        // A container of an earlier claim that started: adopt it.
        await this.markRunning(existing.id, recreate)
        return
      }
      await removeContainerById(this.docker, existing.id)
      container = await this.docker.createContainer(spec)
    }
    try {
      this.signal.throwIfAborted()
      const archive = runtimeArchive(runtimeBinary())
      try {
        await container.putArchive(archive, { path: '/', abortSignal: this.signal })
      } finally {
        archive.destroy()
      }
      await this.markRunning(container.id, recreate)
    } catch (error) {
      await removeContainerById(this.docker, container.id).catch((removeError: unknown) =>
        this.log.warn('removing the script-run container failed', { err: removeError }),
      )
      if (error instanceof RunSettled || this.signal.aborted) throw error
      throw platformFailure(`preparing the container failed: ${(error as Error).message}`)
    }
    try {
      await container.start()
    } catch (error) {
      await removeContainerById(this.docker, container.id).catch(() => undefined)
      throw platformFailure(`the container did not start: ${(error as Error).message}`)
    }
    this.system('the script started')
  }

  /** The one conditional update before the start: building → running (or running → running for a recreate). */
  private async markRunning(containerId: string, recreate: boolean): Promise<void> {
    const now = new Date()
    const updated = await useCollections().scriptRuns.findOneAndUpdate(
      { _id: this.id, state: recreate ? 'running' : 'building' },
      {
        $set: {
          state: 'running',
          container: { id: containerId, name: scriptRunContainerName(this.id), createdAt: now },
          startedAt: this.doc.startedAt ?? now,
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    )
    if (!updated) throw new RunSettled()
    this.doc = updated
    this.containerId = containerId
    await updateLatestRunPointer(updated)
  }

  // ── run ───────────────────────────────────────────────────────────────────

  /** Follows the recorded container until it exits; adopts, recreates or fails it by its state. */
  private async supervise(): Promise<ContainerExit> {
    for (;;) {
      this.signal.throwIfAborted()
      const id = this.containerId
      if (!id) throw new RunFailure([], { type: 'crash', message: 'the script-run container was never recorded' })
      const status = await inspectContainer(this.docker, id)
      if (!status) throw new RunFailure([], { type: 'crash', message: 'the script-run container disappeared' })
      if (status.status === 'created') {
        await removeContainerById(this.docker, id)
        await this.startContainer(true)
        continue
      }
      if (status.status === 'exited' || status.status === 'dead') {
        await this.drainLogs(id)
        return { exitCode: status.exitCode, oomKilled: status.oomKilled, timedOut: false }
      }
      return this.followUntilExit(id)
    }
  }

  private deadline(): number {
    const started = (this.doc.startedAt ?? new Date()).getTime()
    return started + (this.doc.input.settings.timeoutMs ?? this.ctx.config.scriptRunTimeoutMs)
  }

  private async followUntilExit(id: string): Promise<ContainerExit> {
    const follower = this.followLogs(id)
    let timedOut = false
    let timer: NodeJS.Timeout | undefined
    const armTimeout = (resolve: () => void) => {
      const remaining = this.deadline() - Date.now()
      if (remaining <= 0) return resolve()
      timer = setTimeout(() => armTimeout(resolve), Math.min(remaining, MAX_TIMER_MS))
    }
    const timeout = new Promise<void>((resolve) => armTimeout(resolve))
    let stoppedRunning = false
    try {
      const exited = this.waitForExit(id)
      const outcome = await Promise.race([
        exited.then(() => 'exited' as const),
        timeout.then(() => 'timeout' as const),
        new Promise<'aborted'>((resolve) => {
          if (this.signal.aborted) resolve('aborted')
          this.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
        }),
      ])
      if (outcome === 'aborted') throw this.signal.reason ?? new Error('aborted')
      if (outcome === 'timeout') {
        timedOut = true
        this.system(
          `the script run exceeded its timeout of ${formatDuration(this.doc.input.settings.timeoutMs ?? this.ctx.config.scriptRunTimeoutMs)}; stopping it`,
        )
        await stopContainerById(this.docker, id)
      }
      await exited
      stoppedRunning = true
    } finally {
      clearTimeout(timer)
      // After the exit the follow stream ends by itself once Docker delivered the last lines; a detach cuts it at once
      // (and drops a half-received line, which the next claim reads again from the cursor).
      if (stoppedRunning) await Promise.race([follower.ended, new Promise((resolve) => setTimeout(resolve, LOG_END_GRACE_MS))])
      follower.stop(stoppedRunning)
      await follower.ended
    }
    await this.drainLogs(id)
    const status = await inspectContainer(this.docker, id)
    if (!status) throw new RunFailure([], { type: 'crash', message: 'the script-run container disappeared' })
    return { exitCode: status.exitCode, oomKilled: status.oomKilled, timedOut }
  }

  /** Resolves when the container stopped running; a broken wait (Docker restart) is retried until the run is ours no more. */
  private async waitForExit(id: string): Promise<void> {
    for (;;) {
      try {
        await this.docker.getContainer(id).wait({ condition: 'not-running', abortSignal: this.signal })
        return
      } catch (error) {
        if (this.signal.aborted) return
        if ((error as { statusCode?: number }).statusCode === 404) return
        this.log.warn('waiting for the script-run container failed; retrying', { scriptRunId: this.id, err: error })
        await sleep(WAIT_RETRY_MS, this.signal)
        const status = await inspectContainer(this.docker, id).catch(() => undefined)
        if (status === null || (status && status.status !== 'running' && status.status !== 'paused' && status.status !== 'restarting')) return
      }
    }
  }

  /**
   * Streams the container log (stdout, stderr, with timestamps) from the cursor into the run log. Frames at or before
   * the cursor were stored by an earlier claim and are skipped. With `follow` the stream ends when the container stops.
   */
  private followLogs(id: string): { stop: (flush?: boolean) => void; ended: Promise<void> } {
    const resume = this.writer.cursor
    const resumeNanos = resume ? timestampNanos(resume.ts) : null
    let skippedAtCursor = 0
    const accept = (ts: string | undefined): boolean => {
      if (!ts || resumeNanos === null || !resume) return true
      const nanos = timestampNanos(ts)
      if (nanos === null || nanos > resumeNanos) return true
      if (nanos < resumeNanos) return false
      if (skippedAtCursor < resume.countAtTs) {
        skippedAtCursor++
        return false
      }
      return true
    }
    const assemblers = {
      stdout: new FrameAssembler((text, ts) =>
        this.writer.append('stdout', text, ts ? new Date(Number((timestampNanos(ts) ?? 0n) / 1_000_000n)) : undefined, ts),
      ),
      stderr: new FrameAssembler((text, ts) => {
        this.rememberStderr(text)
        this.writer.append('stderr', text, ts ? new Date(Number((timestampNanos(ts) ?? 0n) / 1_000_000n)) : undefined, ts)
      }),
    }
    const sink = (stream: 'stdout' | 'stderr') =>
      new Writable({
        write: (chunk: Buffer, _encoding, callback) => {
          const payload = chunk.toString('utf8')
          const match = /^(\S+) /.exec(payload)
          const ts = match ? match[1] : undefined
          if (accept(ts)) assemblers[stream].frame(match ? payload.slice(match[0].length) : payload, ts)
          callback()
        },
      })
    let stream: NodeJS.ReadableStream | null = null
    let stopped = false
    let flushOnEnd = true
    const ended = (async () => {
      try {
        const since = resume ? sinceOf(resume.ts) : undefined
        stream = (await this.docker.getContainer(id).logs({
          follow: true,
          stdout: true,
          stderr: true,
          timestamps: true,
          ...(since ? { since: since as unknown as number } : {}),
        })) as unknown as NodeJS.ReadableStream
        if (stopped) {
          ;(stream as unknown as { destroy?: () => void }).destroy?.()
          return
        }
        this.docker.modem.demuxStream(stream, sink('stdout'), sink('stderr'))
        await new Promise<void>((resolve) => {
          stream!.once('end', resolve)
          stream!.once('close', resolve)
          stream!.once('error', () => resolve())
        })
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) this.log.warn('following the script-run log failed', { scriptRunId: this.id, err: error })
      } finally {
        if (flushOnEnd) {
          assemblers.stdout.end()
          assemblers.stderr.end()
        }
      }
    })()
    return {
      stop: (flush = true) => {
        stopped = true
        flushOnEnd &&= flush
        ;(stream as unknown as { destroy?: () => void } | null)?.destroy?.()
      },
      ended,
    }
  }

  /** Reads the rest of a stopped container's log (from the cursor), bounded in time. */
  private async drainLogs(id: string): Promise<void> {
    const follower = this.followLogs(id)
    const timer = setTimeout(() => follower.stop(), LOG_DRAIN_MS)
    try {
      await follower.ended
    } finally {
      clearTimeout(timer)
    }
  }

  private rememberStderr(text: string): void {
    this.stderrTail.push(text)
    if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
  }

  /** The last stderr lines, masked like the log (before the cut, so no part of a secret survives it). */
  private stderrSummary(): string | undefined {
    return stderrSummaryOf(this.stderrTail, this.secrets)
  }

  // ── finish ────────────────────────────────────────────────────────────────

  private async settleOutputs(): Promise<ScriptRunDoc> {
    await flushScriptRunState(this.id).catch((error: unknown) =>
      this.log.warn('writing the pending progress or checkpoint failed', { scriptRunId: this.id, err: error }),
    )
    const current = (await useCollections().scriptRuns.findOne({ _id: this.id })) ?? this.doc
    await abortPendingOutputs(current).catch((error: unknown) => this.log.warn('aborting the pending outputs failed', { scriptRunId: this.id, err: error }))
    return current
  }

  private async finish(exit: ContainerExit): Promise<void> {
    this.system(exit.oomKilled ? 'the script was killed: out of memory' : `the script exited with code ${exit.exitCode}`)
    const current = await this.settleOutputs()
    const timeoutMs = current.input.settings.timeoutMs ?? this.ctx.config.scriptRunTimeoutMs
    const { state, error } = exitOutcome(exit, current.error, this.stderrSummary(), timeoutMs)
    await this.settle(state, { error, exitCode: exit.exitCode })
  }

  private async fail(failure: RunFailure): Promise<void> {
    for (const error of failure.errors) this.system(`failed: ${error.message}`)
    if (failure.error && failure.errors.length === 0) this.system(`failed: ${failure.error.message}`)
    await this.settleOutputs()
    await this.settle('failed', { errors: failure.errors.slice(0, 200), error: failure.error })
  }

  /**
   * The final conditional update (non-terminal → state) after the log is flushed, the script's pointer, the event and
   * the container removal. A cancel requested meanwhile wins: the run already counts as cancelled.
   */
  private async settle(state: ScriptRunState, set: Partial<Pick<ScriptRunDoc, 'error' | 'errors' | 'exitCode'>>): Promise<void> {
    this.stopWatching()
    await this.writer.flush()
    const now = new Date()
    const updated =
      (await useCollections().scriptRuns.findOneAndUpdate(
        { _id: this.id, state: { $in: NON_TERMINAL }, cancelRequest: null },
        { $set: { ...set, state, finishedAt: now, expiresAt: expiresAtOf(now, this.ctx.config.scriptRunRetentionDays), updatedAt: now } },
        { returnDocument: 'after' },
      )) ?? (await settleCancelRequest(this.id, set.exitCode === undefined ? {} : { exitCode: set.exitCode }))
    if (updated) {
      this.doc = updated
      await updateLatestRunPointer(updated)
      await scriptRunEvent(updated)
      this.log.info('script run finished', { scriptRunId: this.id, state: updated.state, exitCode: set.exitCode ?? null })
    } else if (set.exitCode !== undefined) {
      await useCollections().scriptRuns.updateOne({ _id: this.id, exitCode: null }, { $set: { exitCode: set.exitCode } })
    }
    await this.removeContainer()
  }

  /**
   * A cancelled run: stop the container (60 s grace: the token still works while a cancel is pending, so the script
   * stores open outputs as `.partial` and its checkpoint), keep its last log lines, abort the outputs left pending,
   * write `cancelled` for a pending cancel (or the exit code), remove the container.
   */
  private async stopCancelled(): Promise<void> {
    this.stopWatching()
    const id = this.containerId
    let exitCode: number | null = null
    if (id) {
      await stopContainerById(this.docker, id).catch((error: unknown) =>
        this.log.warn('stopping the script-run container failed', { scriptRunId: this.id, err: error }),
      )
      await this.drainLogs(id).catch(() => undefined)
      exitCode = (await inspectContainer(this.docker, id).catch(() => null))?.exitCode ?? null
    }
    this.system('the script run was cancelled')
    await this.settleOutputs()
    await this.writer.flush()
    const settled = await settleCancelRequest(this.id, exitCode === null ? {} : { exitCode })
    if (settled) {
      this.doc = settled
      await updateLatestRunPointer(settled)
    } else if (exitCode !== null) {
      await useCollections().scriptRuns.updateOne({ _id: this.id, exitCode: null }, { $set: { exitCode } })
    }
    await this.removeContainer()
    this.log.info('script run cancelled', { scriptRunId: this.id })
  }

  private async removeContainer(): Promise<void> {
    if (!this.containerId) return
    await removeContainerById(this.docker, this.containerId).catch((error: unknown) =>
      this.log.warn('removing the script-run container failed', { scriptRunId: this.id, containerId: this.containerId, err: error }),
    )
  }
}

async function runScriptRunJob(job: JobDoc, ctx: JobContext): Promise<void> {
  const scriptRunId = String(job.params.scriptRunId ?? job.subject.id)
  const doc = await useCollections().scriptRuns.findOne({ _id: scriptRunId })
  if (!doc) throw new FatalJobError('notFound', `script run ${scriptRunId} does not exist`)
  if (!NON_TERMINAL.includes(doc.state)) {
    // Settled while the job was queued (a cancel, the gc): only the container and pending outputs may be left.
    if (doc.container) await removeContainerById(useDocker(), doc.container.id).catch(() => undefined)
    await abortPendingOutputs(doc).catch((error: unknown) => ctx.log.warn('aborting the pending outputs failed', { scriptRunId, err: error }))
    return
  }
  await new ScriptRunExecution(doc, ctx).run()
}

/**
 * Ends an active run from outside its job (the job failed for good, or the gc found it without a running job): failed
 * (platform), or `cancelled` when a cancel was pending; the container removed, pending outputs aborted and a job still
 * queued for it cancelled. Returns the settled state, or null when the run was no longer active.
 */
export async function failScriptRun(
  scriptRunId: string,
  message: string,
  config: Pick<Config, 'scriptRunRetentionDays'>,
  log: Pick<Logger, 'warn'>,
): Promise<ScriptRunState | null> {
  const now = new Date()
  const settled =
    (await useCollections().scriptRuns.findOneAndUpdate(
      { _id: scriptRunId, state: { $in: NON_TERMINAL }, cancelRequest: null },
      {
        $set: {
          state: 'failed',
          errors: [platformError(message)],
          error: { type: 'platform', message: message.slice(0, 16 * 1024) },
          finishedAt: now,
          expiresAt: expiresAtOf(now, config.scriptRunRetentionDays),
          updatedAt: now,
        },
      },
      { returnDocument: 'after' },
    )) ?? (await settleCancelRequest(scriptRunId))
  if (!settled) return null
  await updateLatestRunPointer(settled)
  await scriptRunEvent(settled)
  if (settled.container) {
    await removeContainerById(useDocker(), settled.container.id).catch((error: unknown) =>
      log.warn('removing the script-run container failed', { scriptRunId, err: error }),
    )
  }
  await abortPendingOutputs(settled).catch((error: unknown) => log.warn('aborting the pending outputs failed', { scriptRunId, err: error }))
  await cancelQueuedScriptRunJob(scriptRunId).catch((error: unknown) =>
    log.warn('cancelling the queued job of a settled script run failed', { scriptRunId, err: error }),
  )
  return settled.state
}

export const scriptRunJobKind: JobKindDefinition = {
  component: 'api',
  concurrency: (config) => config.scriptRunConcurrency,
  perUserConcurrency: (config) => config.scriptRunConcurrencyPerUser,
  maxAttempts: 10,
  backoff: { initialMs: 5000, maxMs: 30_000 },
  refundAttemptOnStop: true,
  handler: runScriptRunJob,
  async onFailed(job, error, { log, config }) {
    await failScriptRun(String(job.params.scriptRunId ?? job.subject.id), error.message, config, log)
  },
}
