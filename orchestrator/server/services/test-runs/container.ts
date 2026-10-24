import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, type Writable } from 'node:stream'
import type Docker from 'dockerode'
import type { ContainerCreateOptions } from 'dockerode'
import { pack as tarPack } from 'tar-stream'
import type { Config } from '../../utils/config'
import { EGRESS_NETWORK } from '../../utils/docker'
import { managedLabels, managedNamePrefix } from '../../utils/labels'
import type { Logger } from '../../utils/logger'

// The test-run container (docs/tasks.md §11.1, §11.2, §11.3; docs/runtime.md §3.1, §15): `scantor-t-<testRunId>` on
// scantor-egress with the worker hardening profile (never privileged, no DinD), memory = per-process memory +
// 256 MiB, CPUs = per-process cpus, PidsLimit 4096, the runtime injected by CopyToContainer with entrypoint
// `/scantor/scantor runtime local --spec /scantor/in/spec.json`; events on stdout, files in /scantor/out.
// runTestRunContainer drives it from creation to exit, and stops it whenever the run is cancelled.

export const TEST_RUN_PIDS_LIMIT = 4096
export const NOFILE_LIMIT = 65_536
export const LOG_MAX_SIZE = '20m'
export const LOG_MAX_FILES = '3'
export const MEMORY_OVERHEAD_BYTES = 256 * 1024 ** 2
export const SPEC_PATH = '/scantor/in/spec.json'
export const OUT_DIR = '/scantor/out'
export const LOG_TAIL_BYTES = 32 * 1024
export const LOG_TAIL_EARLIER_BYTES = 4 * 1024

export function testRunContainerName(testRunId: string): string {
  return `${managedNamePrefix('testRun')}${testRunId}`
}

export interface TestRunContainerInput {
  testRunId: string
  userId: string
  /** the draft image (id or reference) */
  image: string
  resources: { cpus: number; memoryMiB: number }
  capAdd: string[]
}

export function testRunContainerSpec(input: TestRunContainerInput): ContainerCreateOptions & { name: string } {
  const memory = input.resources.memoryMiB * 1024 ** 2 + MEMORY_OVERHEAD_BYTES
  return {
    name: testRunContainerName(input.testRunId),
    Image: input.image,
    Entrypoint: ['/scantor/scantor', 'runtime', 'local', '--spec', SPEC_PATH],
    Cmd: [],
    Labels: managedLabels('testRun', { 'scantor.user': input.userId }),
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      NetworkMode: EGRESS_NETWORK,
      CapDrop: ['ALL'],
      CapAdd: [...input.capAdd],
      SecurityOpt: ['no-new-privileges:true'],
      Init: true,
      PidsLimit: TEST_RUN_PIDS_LIMIT,
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(input.resources.cpus * 1e9),
      Ulimits: [{ Name: 'nofile', Soft: NOFILE_LIMIT, Hard: NOFILE_LIMIT }],
      LogConfig: { Type: 'local', Config: { 'max-size': LOG_MAX_SIZE, 'max-file': LOG_MAX_FILES } },
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
    },
  }
}

export interface LocalSpecInput {
  testRunId: string
  entry: string
  taskConfig: Record<string, unknown>
  scanConfig: Record<string, unknown> | null
  analysisConfig: Record<string, unknown> | null
  limit: number
  timeoutMs: number
  maxAttempts: number
  backoff: { initialMs: number; factor: number; maxMs: number; jitter: boolean }
  maxAnalysesPerProcess: number
  totalTimeoutMs: number
  uploads: Record<string, { sha256: string }>
}

/** The local-mode spec of a test run (docs/tasks.md §11.3, docs/runtime.md §15.1). */
export function localSpec(input: LocalSpecInput, config: Pick<Config, 'trancoUrl' | 'cruxUrl' | 'maxAnalysisConfigBytes' | 'maxResultBytes' | 'maxFileBytes' | 'maxFilesPerAnalysis'>) {
  return {
    v: 1,
    runId: input.testRunId,
    entry: input.entry,
    taskConfig: input.taskConfig,
    scanConfig: input.scanConfig,
    analysisConfig: input.analysisConfig,
    limit: input.limit,
    processes: 1,
    timeoutMs: input.timeoutMs,
    maxAttempts: input.maxAttempts,
    backoff: input.backoff,
    maxAnalysesPerProcess: input.maxAnalysesPerProcess,
    totalTimeoutMs: input.totalTimeoutMs,
    debug: false,
    dataSources: { tranco: config.trancoUrl, crux: config.cruxUrl },
    uploads: Object.fromEntries(Object.entries(input.uploads).map(([id, upload]) => [id, { path: `/scantor/in/uploads/${id}`, sha256: upload.sha256 }])),
    resolved: {},
    limits: {
      maxAnalysisConfigBytes: config.maxAnalysisConfigBytes,
      maxResultBytes: config.maxResultBytes,
      maxFileBytes: config.maxFileBytes,
      maxFilesPerAnalysis: config.maxFilesPerAnalysis,
      logTailBytes: LOG_TAIL_BYTES,
      logTailEarlierBytes: LOG_TAIL_EARLIER_BYTES,
    },
    outDir: OUT_DIR,
  }
}

export interface InjectionUpload {
  id: string
  bytes: number
  open: () => Promise<Readable>
}

/**
 * The injection tar extracted at `/` (docs/runtime.md §3.1): `scantor/` (0755), `scantor/scantor` (0755, the runtime
 * binary), `scantor/in/` (0755), `scantor/in/spec.json` (0644), `scantor/in/uploads/<id>` (0644) and
 * `scantor/out/` (01777), all owned by 0:0. Entries stream; nothing is buffered whole. Destroying the returned stream
 * (an aborted CopyToContainer) also closes the file or upload stream being copied.
 */
export function injectionArchive(binaryPath: string, spec: unknown, uploads: InjectionUpload[]): Readable {
  const pack = tarPack()
  const owner = { uid: 0, gid: 0, uname: '', gname: '', mtime: new Date(0) }
  const copy = async (source: Readable, header: { name: string; mode: number; size: number }) => {
    try {
      await new Promise<void>((resolve, reject) => {
        const entry = pack.entry({ ...header, type: 'file', ...owner }, (error) => (error ? reject(error) : resolve()))
        source.on('error', reject).pipe(entry)
      })
    } finally {
      // A destroyed pack only unpipes the source; an open S3 response would otherwise stay paused.
      source.destroy()
    }
  }
  const run = async () => {
    const binary = await stat(binaryPath)
    pack.entry({ name: 'scantor/', type: 'directory', mode: 0o755, ...owner })
    await copy(createReadStream(binaryPath), { name: 'scantor/scantor', mode: 0o755, size: binary.size })
    pack.entry({ name: 'scantor/in/', type: 'directory', mode: 0o755, ...owner })
    pack.entry({ name: 'scantor/in/spec.json', type: 'file', mode: 0o644, ...owner }, JSON.stringify(spec))
    if (uploads.length > 0) pack.entry({ name: 'scantor/in/uploads/', type: 'directory', mode: 0o755, ...owner })
    for (const upload of uploads) {
      await copy(await upload.open(), { name: `scantor/in/uploads/${upload.id}`, mode: 0o644, size: upload.bytes })
    }
    pack.entry({ name: 'scantor/out/', type: 'directory', mode: 0o1777, ...owner })
    pack.finalize()
  }
  run().catch((error: unknown) => pack.destroy(error as Error))
  return Readable.from(pack)
}

export async function removeContainer(docker: Docker, name: string): Promise<void> {
  try {
    await docker.getContainer(name).remove({ force: true, v: true })
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error
  }
}

export interface TestRunContainerOptions {
  docker: Docker
  /** the container spec (testRunContainerSpec) */
  create: ContainerCreateOptions & { name: string }
  /** the injection tar, opened once the container exists */
  archive: () => Readable
  stdout: Writable
  stderr: Writable
  /** the container is killed when it runs longer than this */
  killAfterMs: number
  /** the run's cancellation (cancelTestRun, task deletion) and the job's own abort */
  signal: AbortSignal
  log: Pick<Logger, 'debug'>
}

export interface TestRunContainerExit {
  container: Docker.Container
  exitCode: number
  /** why the platform killed the container, if it did */
  killed: 'timeout' | 'abort' | null
  /** settles when the attached output has ended */
  outputEnded: Promise<void>
}

/**
 * Runs the test-run container from creation to exit: removes a leftover of the same name, creates the container,
 * copies the injection tar into it, attaches to its output, starts it and waits for it, killing it after `killAfterMs`.
 * An abort is honoured at every step (docs/tasks.md §11.1 step 5): the handler exists before the container does and
 * each step re-checks the signal. Before the start the container is removed and the call rejects with the abort
 * reason; once it is started it is killed and the call returns with `killed: 'abort'`.
 */
export async function runTestRunContainer(options: TestRunContainerOptions): Promise<TestRunContainerExit> {
  const { docker, signal, log } = options
  let container: Docker.Container | null = null
  let started = false
  let killSent = false
  let killed: TestRunContainerExit['killed'] = null
  const kill = (reason: 'timeout' | 'abort') => {
    killed ??= reason
    // A container that is not started yet cannot be killed; the step after the abort removes it.
    if (!started || !container || killSent) return
    killSent = true
    container.kill().catch((error: unknown) => log.debug('killing the test-run container failed', { err: error }))
  }
  const onAbort = () => kill('abort')
  signal.addEventListener('abort', onAbort, { once: true })
  let output: Readable | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    await removeContainer(docker, options.create.name)
    signal.throwIfAborted()
    container = await docker.createContainer(options.create)
    signal.throwIfAborted()
    const archive = options.archive()
    try {
      await container.putArchive(archive, { path: '/', abortSignal: signal })
    } finally {
      archive.destroy()
    }
    signal.throwIfAborted()
    // The response of a non-hijacked attach: an IncomingMessage, typed only as a ReadWriteStream.
    const attached = (await container.attach({ stream: true, stdout: true, stderr: true })) as unknown as Readable
    output = attached
    const outputEnded = new Promise<void>((resolve) => {
      attached.once('end', resolve)
      attached.once('close', resolve)
      attached.once('error', () => resolve())
    })
    docker.modem.demuxStream(attached, options.stdout, options.stderr)
    signal.throwIfAborted()
    await container.start()
    started = true
    if (signal.aborted) kill('abort')
    timer = setTimeout(() => kill('timeout'), options.killAfterMs)
    const exitCode = ((await container.wait()) as { StatusCode: number }).StatusCode
    return { container, exitCode, killed, outputEnded }
  } catch (error) {
    output?.destroy()
    // Never started: nothing may run it later, and the job's cleanup comes only after the run's final state.
    if (!started && container) {
      await removeContainer(docker, options.create.name).catch((removeError: unknown) => log.debug('removing the test-run container failed', { err: removeError }))
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
