import type { NodeDoc, ScanDoc, WorkerDoc } from '../../../server/types/documents'
import type { LogFields, Logger, LogLevelName } from '../../../server/utils/logger'

// Builders and a recording logger for the node, runtime and registry tests: plain documents with readable defaults,
// overridden per test (docs/data-model.md §4.5, §4.7, §4.8).

export const T0 = new Date('2026-10-21T10:00:00.000Z')
export const MiB = 1024 ** 2

export function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000)
}

export const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
export const SCAN_ID = '5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f'
export const NODE_ID = '2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a'
export const TASK_ID = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
export const REVISION_ID = 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
export const DIGEST = `sha256:${'4e5f6a7b'.repeat(8)}`

export interface RecordedLog {
  level: LogLevelName
  msg: string
  fields: LogFields
}

export function recordingLogger(records: RecordedLog[] = [], base: LogFields = {}): Logger & { records: RecordedLog[] } {
  const emit = (level: LogLevelName) => (msg: string, fields?: LogFields) => {
    records.push({ level, msg, fields: { ...base, ...fields } })
  }
  return {
    records,
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    warnUnredacted: emit('warn'),
    child: (fields) => recordingLogger(records, { ...base, ...fields }),
  }
}

export function nodeDoc(overrides: Partial<NodeDoc> = {}): NodeDoc {
  return {
    _id: NODE_ID,
    name: 'scan-eu-1',
    builtIn: false,
    state: 'online',
    endpointProfile: 'public',
    tokenHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    tokenPrefix: 'snt_3q8Z',
    tokenRotatedAt: null,
    pool: 'shared',
    labels: { region: 'eu' },
    maxWorkers: null,
    cordoned: false,
    instance: { id: 'engine-a:7d1e', version: '1.4.0', startedAt: T0, lastSeenAt: T0 },
    info: {
      version: '1.4.0',
      hostname: 'scan-eu-1',
      os: 'linux',
      arch: 'amd64',
      kernel: '6.8.0',
      dockerVersion: '29.9.2',
      cpus: 16,
      memoryBytes: 64 * 1024 ** 3,
      diskFreeBytes: 400 * 1024 ** 3,
      dindMode: 'disabled',
      maxWorkers: 8,
      egressDenyApplied: true,
    },
    assignmentsRev: 42,
    lastSeenAt: T0,
    createdBy: USER_ID,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }
}

export function workerDoc(id: string, overrides: Partial<WorkerDoc> = {}): WorkerDoc {
  return {
    _id: id,
    userId: USER_ID,
    scanId: SCAN_ID,
    role: 'runner',
    nodeId: NODE_ID,
    epoch: 0,
    state: 'running',
    stateReason: null,
    spec: {
      repository: `tasks/${TASK_ID}`,
      digest: DIGEST,
      resources: { cpus: 1, memoryMiB: 512 },
      privileged: false,
      dindMode: null,
      specHash: 'sha256:5d41402abc4b2a76b9719d911017c592',
    },
    processes: { desired: 2, assigned: 2, applied: 2, running: 2 },
    container: null,
    runtime: null,
    logs: null,
    createdAt: T0,
    assignedAt: T0,
    startedAt: null,
    stoppedAt: null,
    updatedAt: T0,
    ...overrides,
  }
}

export function scanDoc(overrides: Partial<ScanDoc> = {}): ScanDoc {
  return {
    _id: SCAN_ID,
    userId: USER_ID,
    name: 'tranco top 100k',
    task: { id: TASK_ID, name: 'origins' },
    revision: {
      id: REVISION_ID,
      number: 3,
      language: 'typescript',
      repository: `tasks/${TASK_ID}`,
      digest: DIGEST,
      platform: { os: 'linux', arch: 'amd64' },
      privileged: false,
      schedule: { kind: 'template', template: 'tranco' },
    },
    state: 'running',
    stateReason: null,
    taskConfig: { expectedStatus: 200, apiKey: '***' },
    scanConfig: { list: 'latest', subdomains: false, offset: 0, limit: 100000 },
    secrets: { taskConfig: {}, scanConfig: {} },
    secretPaths: { taskConfig: ['/apiKey'], scanConfig: [], analysisConfig: [], result: [] },
    uploadIds: [],
    settings: {
      workers: 4,
      processes: 2,
      timeoutMs: 300000,
      maxAttempts: 3,
      backoff: { initialMs: 5000, factor: 2, maxMs: 600000, jitter: true },
      resources: { cpus: 1, memoryMiB: 512 },
      maxAnalysesPerProcess: 1000,
      nodeSelector: { pool: 'shared', labels: {} },
      privileged: false,
    },
    round: 1,
    scheduling: { state: 'running', confirmed: 42000, tailHash: `sha256:${'9b1c'.repeat(16)}`, epoch: 1, restarts: 0, resolved: {}, error: null, startedAt: T0, checkpointAt: T0, doneAt: null },
    stats: { pending: 0, retrying: 17, succeeded: 39811, failed: 102, lost: 0, cancelled: 0, expectedTotal: 100000, ratePerMin: 8100, recountedAt: T0 },
    conditions: [],
    breaker: null,
    clonedFrom: null,
    createdAt: T0,
    updatedAt: T0,
    startedAt: T0,
    pausedAt: null,
    completedAt: null,
    deletedAt: null,
    ...overrides,
  }
}
