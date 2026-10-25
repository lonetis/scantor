import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { Logger } from '../../utils/logger'
import { scantorBinary } from './binary'
import { type BuildResult, isPushGateEvent, LineSplitter, parsePipelineEvent, type PipelineEvent } from './events'

// The task-pipeline driver (docs/architecture.md §4.1, docs/tasks.md §9): spawns `scantor task build -` as a
// subprocess talking to the host Docker daemon, streams the pack into its stdin, decodes the NDJSON events of its
// stdout and, for `--push`, answers the push-gate event on fd 3 once the caller's handshake allows it. Builds never
// use dockerode. A wall-clock limit kills the subprocess (SIGTERM, then SIGKILL) as a safety net above the binary's
// own build and describe timeouts.

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
  const { log } = options
  const args = taskBuildArgs(options)
  const child = spawn(options.binary ?? scantorBinary(), args, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe', options.push ? 'pipe' : 'ignore'],
  })
  // stdio is ['pipe', 'pipe', 'pipe', …], so the three standard streams always exist.
  const stdin = child.stdin!
  const stdout = child.stdout!
  const stderr = child.stderr!
  const gate = options.push ? (child.stdio[3] as Writable | null) : null
  const gateAbort = new AbortController()
  let result: BuildResult | null = null
  let timedOut = false
  let aborted = false
  let stderrTail = ''
  let killTimer: NodeJS.Timeout | null = null

  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    killTimer ??= setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
  }
  const timeout = setTimeout(() => {
    timedOut = true
    log.warn('task pipeline exceeded its wall-clock limit; killing it', { timeoutMs: options.timeoutMs })
    kill()
  }, options.timeoutMs)
  const onAbort = () => {
    aborted = true
    kill()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  gate?.on('error', (error) => log.debug('push gate pipe failed', { err: error }))
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
    if (event.type === 'result' && event.result) result = event.result
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

  return new Promise<TaskBuildOutcome>((resolve) => {
    let settled = false
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      gateAbort.abort()
      if (gate && !gate.writableEnded) gate.end()
      const done = () => resolve({ exitCode, result, timedOut, aborted, stderrTail })
      // Wait until every buffered line has been parsed and handled (bounded: a failed spawn never ends stdout).
      const linesEnded = new Promise<void>((resolveEnd) => {
        if (lines.readableEnded) return resolveEnd()
        lines.once('end', resolveEnd)
        setTimeout(resolveEnd, 2000).unref()
      })
      void linesEnded.then(() => chain).then(done, done)
    }
    child.once('error', (error) => {
      log.error('starting the task pipeline failed', { err: error })
      stderrTail = `${stderrTail}${(error as Error).message}`
      finish(null)
    })
    child.once('close', (code) => finish(code))
  })
}
