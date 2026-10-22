import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { ContainerCreateOptions } from 'dockerode'
import { pack as tarPack } from 'tar-stream'
import type { Config } from '../../utils/config'
import { EGRESS_NETWORK } from '../../utils/docker'
import { managedLabels, managedNamePrefix } from '../../utils/labels'

// The test-run container (docs/tasks.md §11.2, §11.3; docs/runtime.md §3.1, §15): `scantor-t-<testRunId>` on
// scantor-egress with the worker hardening profile (never privileged, no DinD), memory = per-process memory +
// 256 MiB, CPUs = per-process cpus, PidsLimit 4096, the runtime injected by CopyToContainer with entrypoint
// `/scantor/scantor runtime local --spec /scantor/in/spec.json`; events on stdout, files in /scantor/out.

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

export function testRunContainerSpec(input: TestRunContainerInput): ContainerCreateOptions {
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
 * `scantor/out/` (01777), all owned by 0:0. Entries stream; nothing is buffered whole.
 */
export function injectionArchive(binaryPath: string, spec: unknown, uploads: InjectionUpload[]): Readable {
  const pack = tarPack()
  const owner = { uid: 0, gid: 0, uname: '', gname: '', mtime: new Date(0) }
  const run = async () => {
    const binary = await stat(binaryPath)
    pack.entry({ name: 'scantor/', type: 'directory', mode: 0o755, ...owner })
    await new Promise<void>((resolve, reject) => {
      const entry = pack.entry({ name: 'scantor/scantor', type: 'file', mode: 0o755, size: binary.size, ...owner }, (error) => (error ? reject(error) : resolve()))
      createReadStream(binaryPath).on('error', reject).pipe(entry)
    })
    pack.entry({ name: 'scantor/in/', type: 'directory', mode: 0o755, ...owner })
    pack.entry({ name: 'scantor/in/spec.json', type: 'file', mode: 0o644, ...owner }, JSON.stringify(spec))
    if (uploads.length > 0) pack.entry({ name: 'scantor/in/uploads/', type: 'directory', mode: 0o755, ...owner })
    for (const upload of uploads) {
      const source = await upload.open()
      await new Promise<void>((resolve, reject) => {
        const entry = pack.entry({ name: `scantor/in/uploads/${upload.id}`, type: 'file', mode: 0o644, size: upload.bytes, ...owner }, (error) =>
          error ? reject(error) : resolve(),
        )
        source.on('error', reject).pipe(entry)
      })
    }
    pack.entry({ name: 'scantor/out/', type: 'directory', mode: 0o1777, ...owner })
    pack.finalize()
  }
  run().catch((error: unknown) => pack.destroy(error as Error))
  return Readable.from(pack)
}
