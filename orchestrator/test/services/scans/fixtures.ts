import { randomUUID } from 'node:crypto'
import type { AnalysisStatus } from '#shared/utils/enums'
import type { AnalysisDoc, NodeDoc, RevisionDoc, ScanDoc, WorkerDoc } from '../../../server/types/documents'

// Documents of the scans area for tests (docs/data-model.md §4.2, §4.5, §4.6, §4.8), with overridable defaults.

export const T0 = new Date('2026-10-21T10:00:00.000Z')

type ScanOverrides = Partial<Omit<ScanDoc, 'scheduling' | 'settings'>> & {
  scheduling?: Partial<ScanDoc['scheduling']>
  settings?: Partial<ScanDoc['settings']>
}

export function scanDoc(overrides: ScanOverrides = {}): ScanDoc {
  const { scheduling, settings, ...rest } = overrides
  const id = rest._id ?? randomUUID()
  return {
    _id: id,
    userId: 'user-a',
    name: null,
    task: { id: 't1', name: 'echo' },
    revision: {
      id: 'r1',
      number: 1,
      language: 'python',
      repository: 'tasks/t1',
      digest: 'sha256:0d1e',
      platform: { os: 'linux', arch: 'amd64' },
      privileged: false,
      schedule: { kind: 'custom' },
    },
    state: 'running',
    stateReason: null,
    taskConfig: {},
    scanConfig: {},
    secrets: { taskConfig: {}, scanConfig: {} },
    secretPaths: { taskConfig: [], scanConfig: [], analysisConfig: [], result: [] },
    uploadIds: [],
    round: 1,
    stats: { pending: 0, retrying: 0, succeeded: 0, failed: 0, lost: 0, cancelled: 0, expectedTotal: null, ratePerMin: 0, recountedAt: null },
    conditions: [],
    breaker: null,
    clonedFrom: null,
    createdAt: T0,
    updatedAt: T0,
    startedAt: T0,
    pausedAt: null,
    completedAt: null,
    deletedAt: null,
    ...rest,
    settings: {
      workers: 1,
      processes: 1,
      timeoutMs: 300_000,
      maxAttempts: 3,
      backoff: { initialMs: 5000, factor: 2, maxMs: 600_000, jitter: true },
      resources: { cpus: 1, memoryMiB: 512 },
      maxAnalysesPerProcess: 1000,
      nodeSelector: { pool: 'shared', labels: {} },
      privileged: false,
      ...settings,
    },
    scheduling: {
      state: 'done',
      confirmed: 0,
      tailHash: null,
      epoch: 0,
      restarts: 0,
      resolved: {},
      error: null,
      startedAt: T0,
      checkpointAt: T0,
      doneAt: T0,
      ...scheduling,
    },
  }
}

export function analysisDoc(scanId: string, seq: number, status: AnalysisStatus, overrides: Partial<AnalysisDoc> = {}): AnalysisDoc {
  return {
    _id: `${scanId}-${seq}`,
    scanId,
    userId: 'user-a',
    seq,
    round: 1,
    status,
    attempt: 1,
    config: { seq },
    attempts: [],
    files: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

export function revisionDoc(overrides: Partial<RevisionDoc> = {}): RevisionDoc {
  return {
    _id: 'r1',
    userId: 'user-a',
    taskId: 't1',
    taskName: 'echo',
    number: 1,
    state: 'ready',
    source: { kind: 'workspace', packSha256: 'a3f1', packBytes: 1, fileCount: 1 },
    snapshotKey: 'snapshots/t1/a3f1.tar.gz',
    image: { repository: 'tasks/t1', tag: 'r1', digest: 'sha256:0d1e', bytes: 1, platform: { os: 'linux', arch: 'amd64' } },
    privileged: false,
    buildLogKey: 'build-logs/r1.ndjson',
    errors: [],
    jobId: 'j1',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

export function nodeDoc(overrides: Partial<NodeDoc> = {}): NodeDoc {
  return {
    _id: randomUUID(),
    name: 'builtin',
    builtIn: true,
    state: 'online',
    endpointProfile: 'internal',
    tokenHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    tokenRotatedAt: null,
    pool: 'shared',
    labels: {},
    maxWorkers: null,
    cordoned: false,
    instance: null,
    info: {
      version: '1.4.0',
      hostname: 'master',
      os: 'linux',
      arch: 'amd64',
      kernel: '6.8.0',
      dockerVersion: '29.9.2',
      cpus: 8,
      memoryBytes: 32 * 1024 ** 3,
      diskFreeBytes: 100 * 1024 ** 3,
      dindMode: 'disabled',
      maxWorkers: 8,
      egressDenyApplied: true,
    },
    assignmentsRev: 0,
    lastSeenAt: T0,
    createdBy: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

export function workerDoc(scanId: string, overrides: Partial<WorkerDoc> = {}): WorkerDoc {
  return {
    _id: randomUUID(),
    userId: 'user-a',
    scanId,
    role: 'runner',
    nodeId: null,
    epoch: 0,
    state: 'pending',
    stateReason: null,
    spec: { repository: 'tasks/t1', digest: 'sha256:0d1e', resources: { cpus: 1, memoryMiB: 512 }, privileged: false, dindMode: null, specHash: '' },
    processes: { desired: 1, assigned: 0, applied: null, running: null },
    container: null,
    runtime: null,
    logs: null,
    createdAt: T0,
    assignedAt: null,
    startedAt: null,
    stoppedAt: null,
    updatedAt: T0,
    ...overrides,
  }
}
