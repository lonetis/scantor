import { randomUUID } from 'node:crypto'
import type Docker from 'dockerode'
import { type Config, useConfig } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { scantorImageRef, useDocker } from '../../utils/docker'
import { type Logger, useLogger } from '../../utils/logger'
import { observeHelperRun, setHelpersRunning } from '../metrics/catalogue'
import { KeyedRwLock, KeyedSemaphore, type Release, Semaphore, SemaphoreTimeoutError } from './concurrency'
import { stderrTail } from './protocol'
import { HelperOutputTooLargeError, HelperTimeoutError, runHelperContainer } from './runner'
import { helperContainerSpec, helperMountFor } from './spec'
import { EXCLUSIVE_OPS, GIT_OPS, type HelperOp, type HelperResult, type HelperRunOptions, type HelperStreamOptions } from './types'

// The workspace helper runner of the api component (docs/architecture.md §4.1, docs/editor.md §9.8): every helper
// takes the user's read/write lock (exclusive for writers), then one of the user's SCANTOR_HELPER_CONCURRENCY_PER_USER
// slots (waiting at most 30 s, else 429 tooManyRequests), then one of SCANTOR_HELPER_CONCURRENCY global slots (waiting
// at most 30 s, else 503 unavailable), and runs its container with the per-operation profile. The per-user cap keeps
// one user's slow uploads or git clones from holding every global slot. The first helper of a user in this process
// runs `init` first, which creates the user's volume subpaths.

export const SLOT_WAIT_MS = 30_000

export interface HelperRuntime {
  docker: Docker
  config: Config
  log: Logger
  slots: Semaphore
  /** SCANTOR_HELPER_CONCURRENCY_PER_USER slots per user, taken before a global slot */
  userSlots: KeyedSemaphore
  userLocks: KeyedRwLock
  /** users whose directories `init` has created in this process */
  initialized: Set<string>
  /** in-flight `init` runs by user, so concurrent first requests share one run */
  initializing: Map<string, Promise<void>>
}

let runtime: HelperRuntime | null = null

export function useHelperRuntime(): HelperRuntime {
  if (!runtime) {
    const config = useConfig()
    runtime = {
      docker: useDocker(),
      config,
      log: useLogger('helpers'),
      slots: new Semaphore(config.helperConcurrency),
      userSlots: new KeyedSemaphore(config.helperConcurrencyPerUser),
      userLocks: new KeyedRwLock(),
      initialized: new Set(),
      initializing: new Map(),
    }
  }
  return runtime
}

/** Test seam: replaces the runtime (docker client, configuration, limits). */
export function setHelperRuntimeForTesting(value: HelperRuntime | null): void {
  runtime = value
}

export function lockModeOf(op: HelperOp): 'shared' | 'exclusive' {
  return EXCLUSIVE_OPS.has(op) ? 'exclusive' : 'shared'
}

/** Runs one helper container without locks (the caller holds them). */
async function runContainer(rt: HelperRuntime, op: HelperOp, options: HelperRunOptions, stream?: HelperStreamOptions): Promise<HelperResult> {
  const args = options.args ?? []
  const network = options.network ?? (GIT_OPS.has(op) ? 'egress' : 'none')
  const spec = helperContainerSpec({
    op,
    userId: options.userId,
    args,
    network,
    mount: helperMountFor(op, args),
    env: options.env ?? {},
    image: scantorImageRef('scantor'),
    memoryBytes: rt.config.helperMemoryLimitBytes,
    pidsLimit: rt.config.helperPidsLimit,
    id: randomUUID(),
  })
  let releaseUser: Release
  try {
    releaseUser = await rt.userSlots.acquire(options.userId, { timeoutMs: SLOT_WAIT_MS, signal: options.signal })
  } catch (error) {
    if (error instanceof SemaphoreTimeoutError) {
      const limit = rt.config.helperConcurrencyPerUser
      throw apiError('tooManyRequests', `at most ${limit} workspace operations of one user run at once, and none finished within 30 s; retry later`, { limit })
    }
    throw error
  }
  let releaseGlobal: Release
  try {
    releaseGlobal = await rt.slots.acquire({ timeoutMs: SLOT_WAIT_MS, signal: options.signal })
  } catch (error) {
    releaseUser()
    if (error instanceof SemaphoreTimeoutError) {
      throw apiError('unavailable', 'no workspace helper slot became free within 30 s; retry later')
    }
    throw error
  }
  const release = () => {
    releaseGlobal()
    releaseUser()
  }
  setHelpersRunning(rt.slots.inUse)
  const started = Date.now()
  let outcome: 'ok' | 'error' | 'timeout' = 'error'
  try {
    const result = await runHelperContainer({
      docker: rt.docker,
      spec,
      stdin: options.stdin,
      stdoutSink: stream?.stdout,
      timeoutMs: rt.config.helperTimeoutMs,
      signal: options.signal,
      log: rt.log,
    })
    rt.log.debug('workspace helper finished', { op, userId: options.userId, exitCode: result.exitCode, durationMs: Date.now() - started })
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      rt.log.error('workspace helper failed', { op, userId: options.userId, exitCode: result.exitCode, stderr: stderrTail(result.stderr) })
    }
    if (result.exitCode === 0) outcome = 'ok'
    return result
  } catch (error) {
    if (error instanceof HelperTimeoutError) {
      outcome = 'timeout'
      rt.log.warn('workspace helper timed out', { op, userId: options.userId, timeoutMs: error.timeoutMs })
      if (GIT_OPS.has(op)) throw apiError('gitFailed', `git ${op === 'git-clone' ? 'clone' : 'fetch'} timed out`, { message: 'timed out' })
      throw apiError('internal', `workspace ${op} timed out`)
    }
    if (error instanceof HelperOutputTooLargeError) {
      rt.log.error('workspace helper output too large', { op, userId: options.userId })
      throw apiError('internal', `workspace ${op} returned too much output`)
    }
    if (isDockerUnavailable(error)) throw apiError('unavailable', 'the Docker daemon is not reachable')
    throw error
  } finally {
    release()
    setHelpersRunning(rt.slots.inUse)
    observeHelperRun(op, outcome, (Date.now() - started) / 1000)
  }
}

function isDockerUnavailable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EACCES'
}

/** Runs `init` for a user (root, both whole volumes) under the user's exclusive lock. */
async function runInit(rt: HelperRuntime, userId: string): Promise<HelperResult> {
  const result = await rt.userLocks.run(userId, 'exclusive', () => runContainer(rt, 'init', { userId, args: ['--user', userId] }))
  if (result.exitCode === 0) rt.initialized.add(userId)
  return result
}

/** Creates the user's directories with the `init` helper once per process (docs/editor.md §9.4, §9.8). */
export async function ensureUserDirsWith(rt: HelperRuntime, userId: string, options: { force?: boolean } = {}): Promise<void> {
  if (!options.force && rt.initialized.has(userId)) return
  const running = rt.initializing.get(userId)
  if (running) return running
  const run = runInit(rt, userId)
    .then((result) => {
      if (result.exitCode !== 0) {
        rt.log.error('workspace init failed', { userId, exitCode: result.exitCode, stderr: stderrTail(result.stderr) })
        throw apiError('internal', 'preparing the workspace failed')
      }
    })
    .finally(() => rt.initializing.delete(userId))
  rt.initializing.set(userId, run)
  return run
}

/**
 * Runs `scantor workspace <op>` for a user under the per-user lock and a global slot. Operations that mount the
 * user's subpath run `init` first (once per process). Returns the raw outcome; callers check it with
 * server/services/helpers/protocol.ts.
 */
export async function executeHelper(op: HelperOp, options: HelperRunOptions, stream?: HelperStreamOptions): Promise<HelperResult> {
  const rt = useHelperRuntime()
  const mount = helperMountFor(op, options.args ?? [])
  if (mount === 'none') return runContainer(rt, op, options, stream)
  if (op === 'init') return runInit(rt, options.userId)
  if (op !== 'purge') await ensureUserDirsWith(rt, options.userId)
  const result = await rt.userLocks.run(options.userId, lockModeOf(op), () => runContainer(rt, op, options, stream))
  if (op === 'purge' && result.exitCode === 0) rt.initialized.delete(options.userId)
  return result
}
