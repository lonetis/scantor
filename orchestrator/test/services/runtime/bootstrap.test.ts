import { describe, expect, it } from 'vitest'
import { type BootstrapConfig, buildBootstrap, type BootstrapParts, revisionEntry } from '../../../server/services/runtime/bootstrap'
import { NODE_ID, REVISION_ID, SCAN_ID, scanDoc, T0, workerDoc } from '../nodes/helpers'

// GET /api/runtime/bootstrap (docs/api.md §8.1, docs/runtime.md §4.1, §17, docs/architecture.md §8): the document a
// worker needs, computed for the endpoint profile of its node; schedulers get the scan config and the scheduler
// part, runners neither.

const SCHEDULER = '7c6d5e4f-3a2b-4c1d-9e0f-8a7b6c5d4e3f'
const RUNNER = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

const config: BootstrapConfig = {
  internalUrl: 'http://orchestrator:3000',
  publicUrl: 'https://scantor.example.com',
  amqpInternalUrl: 'amqp://rabbitmq:5672',
  amqpPublicUrl: 'amqps://amqp.scantor.example.com:443',
  registryPort: 5000,
  registryPublicHost: 'registry.example.com',
  uploadTimeoutMs: 900_000,
  maxFileBytes: 1_073_741_824,
  maxFilesPerAnalysis: 100,
  maxAnalysisConfigBytes: 65_536,
  maxResultBytes: 1_048_576,
  maxAnalysesPerScan: 20_000_000,
  maxProcessesPerWorker: 64,
  workerMinFreeTmpBytes: 1_073_741_824,
  workerDrainGraceMs: 30_000,
  scanQueueMaxReady: 100_000,
  trancoUrl: 'https://tranco-list.eu',
  cruxUrl: 'https://raw.githubusercontent.com/zakird/crux-top-lists/main',
}

function parts(overrides: Partial<BootstrapParts> = {}): BootstrapParts {
  return {
    now: new Date(1761040805123),
    action: 'run',
    worker: workerDoc(SCHEDULER, { role: 'scheduler', epoch: 1, processes: { desired: 1, assigned: 1, applied: 1, running: null } }),
    scan: scanDoc(),
    revision: { manifest: { scantor: 1, name: 'origins', language: 'typescript', entry: 'main.ts' }, description: null },
    profile: 'internal',
    config,
    taskConfig: { expectedStatus: 200, apiKey: 'real-secret-value' },
    scanConfig: { list: 'latest', subdomains: false, offset: 0, limit: 100000 },
    amqpPassword: 'pW3n9Xq0vK2mB7cR5tY8uZ1aS4dF6gH',
    uploads: {},
    ...overrides,
  }
}

describe('buildBootstrap', () => {
  it('builds the scheduler bootstrap of docs/api.md §8.1 for the internal profile', () => {
    const bootstrap = buildBootstrap(parts())
    expect(bootstrap).toEqual({
      serverTime: 1761040805123,
      action: 'run',
      worker: { id: SCHEDULER, role: 'scheduler', scanId: SCAN_ID, nodeId: NODE_ID, epoch: 1 },
      scan: {
        id: SCAN_ID,
        state: 'running',
        round: 1,
        taskConfig: { expectedStatus: 200, apiKey: 'real-secret-value' },
        scanConfig: { list: 'latest', subdomains: false, offset: 0, limit: 100000 },
        settings: {
          processes: 1,
          timeoutMs: 300000,
          maxAttempts: 3,
          backoff: { initialMs: 5000, factor: 2, maxMs: 600000, jitter: true },
          resources: { cpus: 1, memoryMiB: 512 },
          maxAnalysesPerProcess: 1000,
        },
      },
      revision: { id: REVISION_ID, number: 3, entry: 'main.ts', protocolVersion: 1, schedule: { kind: 'template', template: 'tranco' } },
      amqp: {
        url: 'amqp://rabbitmq:5672',
        vhost: 'scantor',
        username: `scan-${SCAN_ID}`,
        password: 'pW3n9Xq0vK2mB7cR5tY8uZ1aS4dF6gH',
        queue: `scantor.scan.${SCAN_ID}`,
        analysesExchange: 'scantor.analyses',
        resultsExchange: 'scantor.results',
        routingKey: SCAN_ID,
        heartbeatSeconds: 30,
        consumerTimeoutMs: 1_500_000,
        maxLength: 100_000,
      },
      uploads: { mode: 'presigned', maxFileBytes: 1073741824, maxFilesPerAnalysis: 100, timeoutMs: 900000 },
      limits: {
        maxAnalysisConfigBytes: 65536,
        maxResultBytes: 1048576,
        maxResultMessageBytes: 2097152,
        logTailBytes: 32768,
        logTailEarlierBytes: 4096,
        stackBytes: 16384,
        maxAnalysesPerScan: 20000000,
        maxProcessesPerWorker: 64,
        minFreeTmpBytes: 1073741824,
      },
      intervals: { statePollMs: 5000, statePollJitter: 0.2, checkpointMs: 5000, checkpointItems: 1000, drainGraceMs: 30000, backpressureWaitMs: 2000 },
      scheduler: {
        restarts: 0,
        checkpoint: { confirmed: 42000, tailHash: `sha256:${'9b1c'.repeat(16)}` },
        resolved: {},
        uploads: {},
        dataSources: { tranco: 'https://tranco-list.eu', crux: 'https://raw.githubusercontent.com/zakird/crux-top-lists/main' },
      },
    })
  })

  it('uses the public AMQP URL for a remote node', () => {
    expect(buildBootstrap(parts({ profile: 'public' })).amqp.url).toBe('amqps://amqp.scantor.example.com:443')
  })

  it('gives runners only the task config, epoch 0, their allowed processes and no scheduler part', () => {
    const runner = workerDoc(RUNNER, { role: 'runner', epoch: 0, processes: { desired: 4, assigned: 4, applied: 2, running: 2 } })
    const bootstrap = buildBootstrap(parts({ worker: runner, scanConfig: {} }))
    expect(bootstrap.worker).toEqual({ id: RUNNER, role: 'runner', scanId: SCAN_ID, nodeId: NODE_ID, epoch: 0 })
    expect(bootstrap.scan).not.toHaveProperty('scanConfig')
    expect(bootstrap.scan.settings.processes).toBe(2)
    expect(bootstrap.scheduler).toBeNull()
  })

  it('returns stored resolutions with ISO times and the restart count', () => {
    const scan = scanDoc()
    scan.scheduling.restarts = 2
    scan.scheduling.resolved = {
      schedule: { template: 'tranco', scanConfig: { list: '262W9' }, provenance: { listId: '262W9' }, expectedTotal: 100000, at: T0 },
    }
    const bootstrap = buildBootstrap(parts({ scan }))
    expect(bootstrap.scheduler?.restarts).toBe(2)
    expect(bootstrap.scheduler?.resolved).toEqual({
      schedule: { template: 'tranco', scanConfig: { list: '262W9' }, provenance: { listId: '262W9' }, expectedTotal: 100000, at: '2026-10-21T10:00:00.000Z' },
    })
  })

  it('derives the consumer timeout from the scan timeout and the upload timeout', () => {
    const scan = scanDoc()
    scan.settings.timeoutMs = 60_000
    expect(buildBootstrap(parts({ scan })).amqp.consumerTimeoutMs).toBe(60_000 + 900_000 + 300_000)
  })
})

describe('revisionEntry', () => {
  it('is the manifest entry, else the language default of schemas/languages.json', () => {
    expect(revisionEntry({ manifest: { entry: 'src/main.py' } }, 'python')).toBe('src/main.py')
    expect(revisionEntry({ manifest: {} }, 'python')).toBe('main.py')
    expect(revisionEntry(null, 'go')).toBe('/task/task')
    expect(() => revisionEntry(null, 'cobol')).toThrow()
  })
})
