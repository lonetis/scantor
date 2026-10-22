import { PassThrough } from 'node:stream'
import type { Collection } from 'mongodb'
import type { JobDoc, LockDoc } from '../../types/documents'
import { useDocker } from '../../utils/docker'
import { releaseLock, LOCK_RENEW_MS, tryAcquireLock } from '../../utils/locks'
import type { Logger } from '../../utils/logger'

// Automatic registry garbage collection (docs/deployment.md §14.1): every SCANTOR_REGISTRY_GC_INTERVAL the
// reconciler takes the `registryGc` lock, waits until no `revisionBuild` job is pushing (the build side of the push
// gate sees the lock and waits in `waitRegistry`), then runs `registry garbage-collect --delete-untagged` inside the
// `scantor-registry` container. Blob storage is measured before and after to log the freed bytes.

export const REGISTRY_CONTAINER = 'scantor-registry'
export const REGISTRY_CONFIG = '/etc/distribution/config.yml'
export const REGISTRY_DATA_DIR = '/var/lib/registry'
export const GC_COMMAND = ['registry', 'garbage-collect', '--delete-untagged', REGISTRY_CONFIG]
const PUSH_POLL_MS = 5000
const PUSH_WAIT_MAX_MS = 30 * 60_000
const GC_TIMEOUT_MS = 30 * 60_000
const DU_TIMEOUT_MS = 5 * 60_000
/** The first collection after a start: soon, because restarts would otherwise postpone it forever. */
export const FIRST_GC_DELAY_MS = 10 * 60_000
const STOP_WAIT_MS = 5000

export interface ExecResult {
  exitCode: number | null
  output: string
}

const OUTPUT_LIMIT = 64 * 1024

/** Runs a command in a container through the Engine API and collects (the end of) its output. */
export async function execInContainer(container: string, cmd: string[], timeoutMs: number): Promise<ExecResult> {
  const docker = useDocker()
  const exec = await docker.getContainer(container).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true })
  const stream = await exec.start({ hijack: true, stdin: false })
  const sink = new PassThrough()
  let output = ''
  sink.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT)
  })
  docker.modem.demuxStream(stream, sink, sink)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy()
      reject(new Error(`${cmd.join(' ')} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    stream.on('end', () => {
      clearTimeout(timer)
      resolve()
    })
    stream.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  const inspected = await exec.inspect()
  return { exitCode: inspected.ExitCode ?? null, output }
}

/** Kilobytes used by the registry's storage, or null when it cannot be measured. */
async function storageKiB(container: string, log: Logger): Promise<number | null> {
  try {
    const result = await execInContainer(container, ['du', '-sk', REGISTRY_DATA_DIR], DU_TIMEOUT_MS)
    const kib = Number.parseInt(result.output.trim().split(/\s+/)[0] ?? '', 10)
    return result.exitCode === 0 && Number.isFinite(kib) ? kib : null
  } catch (error) {
    log.warn('measuring the registry storage failed', { err: error })
    return null
  }
}

/** True while a revision build is pushing (its push gate is open). */
export async function pushInProgress(jobs: Collection<JobDoc>): Promise<boolean> {
  return (await jobs.countDocuments({ kind: 'revisionBuild', state: 'running', 'cursor.phase': 'push' }, { limit: 1 })) > 0
}

let lastSuccessAt: Date | null = null

/** Time of the last successful collection in this process (metric scantor_registry_gc_last_success_timestamp_seconds). */
export function registryGcLastSuccess(): Date | null {
  return lastSuccessAt
}

export interface RegistryGcDeps {
  locks: Collection<LockDoc>
  jobs: Collection<JobDoc>
  log: Logger
  signal: AbortSignal
  /** the registry container to exec into (default `scantor-registry`, the fixed compose container name) */
  container?: string
}

export type RegistryGcResult = 'collected' | 'skippedLocked' | 'skippedPushing' | 'skippedNoRegistry' | 'failed'

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** One collection round under the `registryGc` lock. */
export async function runRegistryGc(deps: RegistryGcDeps): Promise<RegistryGcResult> {
  const { locks, jobs, log, signal } = deps
  const container = deps.container ?? REGISTRY_CONTAINER
  if (!(await tryAcquireLock(locks, 'registryGc'))) return 'skippedLocked'
  const renew = setInterval(() => {
    tryAcquireLock(locks, 'registryGc').catch((error: unknown) => log.warn('renewing the registryGc lock failed', { err: error }))
  }, LOCK_RENEW_MS)
  try {
    try {
      await useDocker().getContainer(container).inspect()
    } catch (error) {
      log.warn(`container ${container} not found; skipping registry garbage collection`, { err: error })
      return 'skippedNoRegistry'
    }
    const deadline = Date.now() + PUSH_WAIT_MAX_MS
    while (await pushInProgress(jobs)) {
      if (Date.now() > deadline || signal.aborted) {
        log.warn('a revision push did not finish in time; skipping this registry garbage collection')
        return 'skippedPushing'
      }
      await sleep(PUSH_POLL_MS, signal)
    }
    const before = await storageKiB(container, log)
    const started = Date.now()
    const result = await execInContainer(container, GC_COMMAND, GC_TIMEOUT_MS)
    if (result.exitCode !== 0) {
      log.error('registry garbage collection failed', { exitCode: result.exitCode, output: result.output.slice(-4096) })
      return 'failed'
    }
    const after = await storageKiB(container, log)
    lastSuccessAt = new Date()
    log.info('registry garbage collection finished', {
      durationMs: Date.now() - started,
      freedBytes: before !== null && after !== null ? Math.max(0, before - after) * 1024 : null,
    })
    return 'collected'
  } catch (error) {
    log.error('registry garbage collection failed', { err: error })
    return 'failed'
  } finally {
    clearInterval(renew)
    await releaseLock(locks, 'registryGc').catch((error: unknown) => log.warn('releasing the registryGc lock failed', { err: error }))
  }
}

/** The reconciler loop: first round after FIRST_GC_DELAY_MS (or the interval when shorter), then every interval. */
export class RegistryGcLoop {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<unknown> | null = null
  private readonly abort = new AbortController()

  constructor(private readonly intervalMs: number, private readonly deps: Omit<RegistryGcDeps, 'signal'>) {}

  start(): void {
    if (this.intervalMs <= 0) {
      this.deps.log.info('automatic registry garbage collection is disabled (SCANTOR_REGISTRY_GC_INTERVAL=0)')
      return
    }
    this.schedule(Math.min(FIRST_GC_DELAY_MS, this.intervalMs))
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = runRegistryGc({ ...this.deps, signal: this.abort.signal }).finally(() => {
        this.running = null
        if (!this.abort.signal.aborted) this.schedule(this.intervalMs)
      })
    }, delayMs)
  }

  /** Stops scheduling; a collection in progress keeps running in the registry, its lock lease simply expires. */
  async stop(): Promise<void> {
    this.abort.abort()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.running) await Promise.race([this.running, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))])
  }
}
