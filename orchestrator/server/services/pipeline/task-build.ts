import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { Logger } from '../../utils/logger'
import { scantorBinary } from './binary'
import { type BuildResult, isPushGateEvent, LineSplitter, parsePipelineEvent, type PipelineEvent } from './events'

// The task-pipeline driver (docs/architecture.md §4.1, docs/tasks.md §9): spawns `scantor task build -` as a
// subprocess talking to the host Docker daemon, streams the pack into its stdin, decodes the NDJSON events of its
// stdout and, for `--push`, answers the push-gate event on fd 3 once the caller's handshake allows it. Other pipeline
// commands reuse the driver (runPipelineCommand); `task bundle` writes its archive to fd 3 instead, which the caller
// reads through `output`. Builds never use dockerode. A wall-clock limit kills the subprocess (SIGTERM, then SIGKILL)
// as a safety net above the binary's own build and describe timeouts.

/** Longest event line accepted from the pipeline (a result carries a describe output of at most 1 MiB). */
export const MAX_EVENT_LINE_BYTES = 4 * 1024 ** 2
const KILL_GRACE_MS = 10_000
const STDERR_TAIL_BYTES = 64 * 1024

export interface TaskBuildOptions {
  /** the pack (tar.gz) streamed into stdin */
  input: Readable
  tag: string
  expectName: string
  allowPrivileged: boolean
  push?: boolean
  skipCheck?: boolean
  reuseExisting?: boolean
  /** subprocess environment (pipelineEnv plus the push password for `--push`) */
  env: Record<string, string>
  /** called for every event, in order; awaited before the next event is processed */
  onEvent: (event: PipelineEvent) => Promise<void> | void
  /**
   * The push-gate handshake (docs/tasks.md §9.7): resolves when the push may start; a rejection closes the gate,
   * which ends the pipeline with a `push` error.
   */
  pushGate?: (signal: AbortSignal) => Promise<void>
  /** wall-clock limit of the whole subprocess */
  timeoutMs: number
  signal?: AbortSignal
  log: Logger
  binary?: string
}

export interface TaskBuildOutcome {
  exitCode: number | null
  /** the final `result` event's BuildResult, or null when the pipeline ended without one */
  result: BuildResult | null
  timedOut: boolean
  aborted: boolean
  /** the last bytes of the subprocess's own stderr (diagnostics, not events) */
  stderrTail: string
  /** why the `output` reader failed (it killed the subprocess); null without `output` or when it succeeded */
  outputError: Error | null
}

export function taskBuildArgs(options: Pick<TaskBuildOptions, 'tag' | 'expectName' | 'allowPrivileged' | 'push' | 'skipCheck' | 'reuseExisting'>): string[] {
  return [
    'task',
    'build',
    '-',
    '--tag',
    options.tag,
    ...(options.push ? ['--push', '--push-gate', '3'] : []),
    '--expect-name',
    options.expectName,
    ...(options.allowPrivileged ? ['--allow-privileged'] : []),
    ...(options.skipCheck ? ['--skip-check'] : []),
    ...(options.reuseExisting ? ['--reuse-existing'] : []),
    '--events',
    'ndjson',
  ]
}

/** Runs `scantor task build -` to completion and returns its outcome. Never rejects for pipeline failures. */
export function runTaskBuild(options: TaskBuildOptions): Promise<TaskBuildOutcome> {
  return runPipelineCommand<BuildResult>(taskBuildArgs(options), options)
}

/** The options runPipelineCommand needs: TaskBuildOptions without the task-build flags, plus `output`. */
export type PipelineCommandOptions = Pick<TaskBuildOptions, 'input' | 'push' | 'env' | 'onEvent' | 'pushGate' | 'timeoutMs' | 'signal' | 'log' | 'binary'> & {
  /**
   * Reads what the subprocess writes to fd 3 (`--output-fd 3`), which becomes a pipe; the outcome waits for the
   * returned promise. It must consume the stream to its end. A rejection kills the subprocess and becomes
   * `outputError`; a stopped or timed-out subprocess destroys the stream with an error, so a reader never mistakes a
   * cut-off stream for a complete one. The wall-clock limit and `signal` also abort the reader's `signal`, also after
   * the subprocess ended: whatever the reader still waits for (an upload) must end on it, so the outcome stays bounded.
   * Cannot be combined with `push`, which uses fd 3 for the gate.
   */
  output?: (stream: Readable, signal: AbortSignal) => Promise<void>
}

/** The outcome of a pipeline subprocess whose final `result` event carries an R. */
export type PipelineCommandOutcome<R> = Omit<TaskBuildOutcome, 'result'> & { result: R | null }

/**
 * Runs a `scantor` pipeline subprocess (`task build -`, `script build -`) with `args` to completion and returns its
 * outcome; the final `result` event's value is returned as R. Never rejects for pipeline failures.
 */
export function runPipelineCommand<R>(args: string[], options: PipelineCommandOptions): Promise<PipelineCommandOutcome<R>> {
  if (options.push && options.output) throw new Error('a pipeline command cannot combine push and output: both use fd 3')
  const { log } = options
  const child = spawn(options.binary ?? scantorBinary(), args, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe', options.push || options.output ? 'pipe' : 'ignore'],
  })
  // stdio is ['pipe', 'pipe', 'pipe', …], so the three standard streams always exist.
  const stdin = child.stdin!
  const stdout = child.stdout!
  const stderr = child.stderr!
  const gate = options.push ? (child.stdio[3] as Writable | null) : null
  const output = options.output ? (child.stdio[3] as Readable | null) : null
  const gateAbort = new AbortController()
  const outputAbort = new AbortController()
  let result: R | null = null
  let timedOut = false
  let aborted = false
  let stderrTail = ''
  let outputError: Error | null = null
  let killTimer: NodeJS.Timeout | null = null

  /**
   * Ends the output with an error, so its reader fails instead of taking a cut-off stream for a complete one, and aborts
   * the reader's signal, which ends what it still waits for once the stream has ended.
   */
  const cutOutput = (reason: string) => {
    if (output && !output.destroyed && !output.readableEnded) output.destroy(new Error(reason))
    if (!outputAbort.signal.aborted) outputAbort.abort(new Error(reason))
  }
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
  }
  // Armed until the output reader settled too (an upload may outlive the subprocess).
  const timeout = setTimeout(() => {
    timedOut = true
    log.warn('task pipeline exceeded its wall-clock limit; killing it', { timeoutMs: options.timeoutMs })
    cutOutput('the task pipeline exceeded its wall-clock limit')
    kill()
  }, options.timeoutMs)
  const onAbort = () => {
    aborted = true
    cutOutput('the task pipeline was stopped')
    kill()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  gate?.on('error', (error) => log.debug('push gate pipe failed', { err: error }))
  output?.on('error', (error) => log.debug('pipeline output pipe failed', { err: error }))
  let outputDone: Promise<void> = Promise.resolve()
  if (output && options.output) {
    const read = options.output
    outputDone = Promise.resolve()
      .then(() => read(output, outputAbort.signal))
      .catch((error: unknown) => {
        outputError = error instanceof Error ? error : new Error(String(error))
        if (!aborted && !timedOut) log.warn('reading the task pipeline output failed; killing the pipeline', { err: error })
        // Nobody reads any more: the subprocess would block on a full pipe.
        if (!output.destroyed) output.destroy()
        kill()
      })
  }
  stdin.on('error', (error) => log.debug('task pipeline stdin closed early', { err: error }))
  options.input.on('error', (error) => {
    log.warn('reading the pack for the task pipeline failed', { err: error })
    stdin.destroy(error)
  })
  options.input.pipe(stdin)

  stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
  })

  const answerGate = async () => {
    if (!gate) return
    try {
      if (options.pushGate) await options.pushGate(gateAbort.signal)
      gate.end('push\n')
    } catch (error) {
      // A stopped build (its job cancelled, its lease lost) closes the gate on purpose; whoever stopped it reports that.
      if (options.signal?.aborted) log.debug('push gate closed: the build was stopped', { err: error })
      else log.warn('push gate closed', { err: error })
      gate.end()
    }
  }

  // Events are processed strictly in order; the gate handshake runs beside them so later events are not blocked.
  let chain = Promise.resolve()
  const lines = stdout.pipe(
    new LineSplitter(MAX_EVENT_LINE_BYTES, (length) => log.warn('dropped an oversized task pipeline event', { bytes: length })),
  )
  lines.on('data', (line: string) => {
    const event = parsePipelineEvent(line)
    if (!event) {
      log.debug('ignored a non-event line of the task pipeline', { line: line.slice(0, 200) })
      return
    }
    if (event.type === 'result' && event.result) result = event.result as unknown as R
    chain = chain.then(async () => {
      try {
        await options.onEvent(event)
      } catch (error) {
        // Once the build was stopped, a failing handler is a consequence of the stop (the cursor write of a cancelled
        // job throws LeaseLostError), which the caller reports.
        if (options.signal?.aborted) log.debug('a task pipeline event was not handled: the build was stopped', { err: error, seq: event.seq })
        else log.error('handling a task pipeline event failed', { err: error, seq: event.seq })
      }
      if (isPushGateEvent(event)) void answerGate()
    })
  })

  return new Promise<PipelineCommandOutcome<R>>((resolve) => {
    let settled = false
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      if (!output) clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      gateAbort.abort()
      if (gate && !gate.writableEnded) gate.end()
      const done = () => {
        clearTimeout(timeout)
        // Kept until here: a stop must still abort an output reader that outlives the subprocess.
        options.signal?.removeEventListener('abort', onAbort)
        resolve({ exitCode, result, timedOut, aborted, stderrTail, outputError })
      }
      // Wait until every buffered line has been parsed and handled (bounded: a failed spawn never ends stdout), then
      // until the output reader has finished (bounded by the wall-clock limit and the signal, which abort the reader).
      const linesEnded = new Promise<void>((resolveEnd) => {
        if (lines.readableEnded) return resolveEnd()
        lines.once('end', resolveEnd)
        setTimeout(resolveEnd, 2000).unref()
      })
      void linesEnded
        .then(() => chain)
        .then(() => outputDone)
        .then(done, done)
    }
    child.once('error', (error) => {
      log.error('starting the task pipeline failed', { err: error })
      stderrTail = `${stderrTail}${(error as Error).message}`
      cutOutput(`starting the task pipeline failed: ${(error as Error).message}`)
      finish(null)
    })
    child.once('close', (code) => finish(code))
  })
}
