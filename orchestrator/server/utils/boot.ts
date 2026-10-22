import type { OrchestratorComponent } from '#shared/utils/enums'
import type { Config } from './config'
import type { Logger } from './logger'

/*
 * Boot and component registries: the extension seam between the orchestrator foundation and the domain areas.
 *
 * Lifecycle (Nitro plugins run in file-name order, synchronously):
 *   server/plugins/00.boot.ts        resets the registries and registers the foundation boot steps
 *   server/plugins/10.components.ts  registers the foundation component tasks (the jobs runners, …)
 *   server/plugins/20-89.<area>.ts   domain plugins: call registerBootStep / registerComponentTask /
 *                                    registerJobKind synchronously at plugin load; never do I/O there
 *   server/plugins/99.start.ts       runs the boot steps in `order`, then starts the component tasks of the
 *                                    components selected by SCANTOR_COMPONENTS; registration closes here
 *
 * Until every boot step has finished, `/api/*` answers 503 `unavailable` (except `/api/health`), and the process
 * exits with code 1 when a boot step fails (docs/architecture.md §4.1: "exits non-zero on any failure before
 * step 7").
 *
 * Boot step order ranges (docs/architecture.md §4.1):
 *   100–199  step 1  configuration and startup guard                        (foundation: 100)
 *   200–299  step 2  MongoDB, migrations, indexes, scantor_query             (foundation: 200)
 *   300–399  step 3  better-auth, jwks cleanup, first admin / setup token    (foundation: 300)
 *   400–499  step 4  S3 bucket, CORS, lifecycle                              (foundation: 400)
 *   500–599  step 5  RabbitMQ vhost, exchanges, global queues, bindings      (foundation: 500)
 *   600–699  step 6  registry and Docker objects:
 *                      610 registry jwks.json + http-secret   (domain: registry)
 *                      620 built-in node upsert               (domain: nodes)
 *                      625 plaintext public endpoint warning  (domain: nodes)
 *                      630 scantor-egress, scantor-workspaces, scantor-editor-home (foundation)
 *                      640 background pull of the editor image (foundation)
 *                      690 operation registry from the OpenAPI document (foundation)
 *   700–899  further domain preparation that must finish before components start:
 *                      700 editor boot sweep                  (domain: editor)
 * Step 7 (component start and listening) is the component task registry below.
 *
 * Component tasks are long-running loops (ingestor consumers, reconciler loops, jobs runners). `start` should
 * return once the task is running (it must not block forever); `stop` must end it and release leases. They are
 * started in registration order and stopped in reverse order on Nitro `close`.
 */

export interface BootContext {
  /** the parsed configuration (available once the configuration step, order 100, has run) */
  readonly config: Config
  log: Logger
}

export interface BootStep {
  /** unique, human-readable name used in logs */
  name: string
  /** position in the boot sequence; see the ranges above */
  order: number
  run(ctx: BootContext): Promise<void> | void
}

export interface ComponentTaskContext {
  config: Config
  log: Logger
  /** aborted when the process stops */
  signal: AbortSignal
}

export interface ComponentTask {
  component: OrchestratorComponent
  /** unique name used in logs */
  name: string
  start(ctx: ComponentTaskContext): Promise<void> | void
  stop(): Promise<void> | void
}

export type BootPhase = 'registering' | 'booting' | 'ready' | 'failed' | 'stopping' | 'stopped'

/** An expected refusal to start (for example the startup guard): logged as its message alone, without a stack. */
export class BootAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BootAbortError'
  }
}

interface BootRegistry {
  phase: BootPhase
  steps: BootStep[]
  tasks: ComponentTask[]
  started: ComponentTask[]
  abort: AbortController
  error: Error | null
}

function emptyRegistry(): BootRegistry {
  return { phase: 'registering', steps: [], tasks: [], started: [], abort: new AbortController(), error: null }
}

// Kept on globalThis so that Nitro dev reloads of this module do not split the registry.
const globalKey = '__scantorBootRegistry'
type GlobalWithRegistry = typeof globalThis & { [globalKey]?: BootRegistry }

function registry(): BootRegistry {
  const global = globalThis as GlobalWithRegistry
  global[globalKey] ??= emptyRegistry()
  return global[globalKey]
}

/** Resets the registries (server/plugins/00.boot.ts). */
export function resetBootRegistry(): void {
  ;(globalThis as GlobalWithRegistry)[globalKey] = emptyRegistry()
}

function assertRegistering(what: string): void {
  if (registry().phase !== 'registering') {
    throw new Error(`${what} must be registered synchronously by a Nitro plugin before boot starts`)
  }
}

export function registerBootStep(step: BootStep): void {
  assertRegistering(`boot step ${step.name}`)
  if (registry().steps.some((existing) => existing.name === step.name)) throw new Error(`boot step ${step.name} is registered twice`)
  registry().steps.push(step)
}

export function registerComponentTask(task: ComponentTask): void {
  assertRegistering(`component task ${task.name}`)
  if (registry().tasks.some((existing) => existing.name === task.name)) throw new Error(`component task ${task.name} is registered twice`)
  registry().tasks.push(task)
}

export function bootPhase(): BootPhase {
  return registry().phase
}

/** True once every boot step has finished and the components have been started. */
export function isBootComplete(): boolean {
  return registry().phase === 'ready'
}

/** The registered boot steps in execution order (stable for equal `order`). */
export function orderedBootSteps(): BootStep[] {
  return [...registry().steps].sort((a, b) => a.order - b.order)
}

export interface RunBootOptions {
  /** resolves the configuration after the configuration step has run */
  config: () => Config
  log: Logger
}

/**
 * Runs every boot step in order, then starts the component tasks of the enabled components (step 7).
 * Rejects with the first failing step's error; the caller exits the process.
 */
export async function runBoot(options: RunBootOptions): Promise<void> {
  const state = registry()
  if (state.phase !== 'registering') throw new Error(`boot already ${state.phase}`)
  state.phase = 'booting'
  try {
    for (const step of orderedBootSteps()) {
      const started = Date.now()
      const log = options.log.child({ bootStep: step.name })
      await step.run({ log, get config() { return options.config() } })
      log.debug('boot step finished', { durationMs: Date.now() - started })
    }
    const config = options.config()
    for (const task of state.tasks) {
      if (!config.components.includes(task.component)) continue
      const log = options.log.child({ component: task.component, task: task.name })
      await task.start({ config, log, signal: state.abort.signal })
      state.started.push(task)
      log.info('component task started')
    }
    state.phase = 'ready'
  } catch (error) {
    state.phase = 'failed'
    state.error = error as Error
    throw error
  }
}

export interface RetryOptions {
  log: Logger
  /** total time to keep retrying (default 60 s) */
  timeoutMs?: number
  /** first delay; doubles up to 5 s (default 500 ms) */
  initialDelayMs?: number
}

/**
 * Runs `fn` until it succeeds or `timeoutMs` has passed, then rethrows the last error. Boot steps use it for
 * dependencies that may still be starting (S3, RabbitMQ, the Docker daemon); each failure is logged.
 */
export async function retryUntil<T>(what: string, fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  let delay = options.initialDelayMs ?? 500
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (Date.now() + delay > deadline) throw error
      options.log.warn(`${what} failed; retrying`, { attempt, retryInMs: delay, err: error })
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 5000)
    }
  }
}

/** Stops started component tasks in reverse order (Nitro `close`). Errors are logged, not thrown. */
export async function stopComponents(log: Logger): Promise<void> {
  const state = registry()
  if (state.phase === 'stopping' || state.phase === 'stopped') return
  state.phase = 'stopping'
  state.abort.abort()
  for (const task of [...state.started].reverse()) {
    try {
      await task.stop()
    } catch (error) {
      log.error('stopping component task failed', { task: task.name, err: error })
    }
  }
  state.started = []
  state.phase = 'stopped'
}
