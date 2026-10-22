import { describe, expect, it } from 'vitest'
import {
  createNodeBody,
  listNodeEventsQuery,
  nodeAssignmentsQuery,
  nodeFormSchema,
  nodeHelloBody,
  nodeStatusBody,
  updateNodeBody,
  workerLogsBody,
} from '../../../shared/schemas/nodes'

// Request schemas of the node API and node administration (docs/api.md §4.17, §7): the docs/api.md examples parse,
// unknown keys are rejected, the built-in node's name is reserved.

const HELLO = {
  instanceId: '4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c:7d1e',
  version: '1.4.0',
  info: {
    hostname: 'scan-eu-1',
    os: 'linux',
    arch: 'amd64',
    kernel: '6.8.0-48-generic',
    dockerVersion: '29.9.2',
    cpus: 16,
    memoryBytes: 68719476736,
    diskFreeBytes: 412316860416,
    dindMode: 'disabled',
    maxWorkers: 8,
    egressDenyApplied: true,
  },
  containers: [{ workerId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', containerId: 'f1e2d3c4b5a6', state: 'running', specHash: 'sha256:5d41' }],
}

const STATUS = {
  instanceId: '4c6f2b1e-9a8d-4e7f-b6c5-3d2e1f0a9b8c:7d1e',
  appliedRev: 42,
  clockOffsetMs: -8,
  info: { version: '1.4.0', cpus: 16, memoryBytes: 68719476736, diskFreeBytes: 409600000000, dindMode: 'disabled', maxWorkers: 8, egressDenyApplied: true },
  workers: [
    { workerId: '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', state: 'running', containerId: 'f1e2d3c4b5a6', startedAt: '2026-10-21T10:00:20.000Z', restarts: 0, applied: { processes: 2, nanoCpus: 2000000000, memoryBytes: 1342177280 } },
    { workerId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', state: 'backoff', containerId: 'a9b8c7d6e5f4', restarts: 3, lastExit: { exitCode: 137, oomKilled: true, at: '2026-10-21T10:04:58.000Z', logTail: '…' }, nextRestartAt: '2026-10-21T10:05:38.000Z' },
    { workerId: '1c2d3e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f', state: 'pulling', pull: { image: 'registry.example.com/tasks/7f3b@sha256:4e5f', startedAt: '2026-10-21T10:05:01.000Z' } },
    { workerId: '2d3e4f5a-6b7c-4d8e-8f9a-0b1c2d3e4f5a', state: 'error', error: { code: 'imagePullFailed', message: 'manifest unknown' } },
    { workerId: '3e4f5a6b-7c8d-4e9f-9a0b-1c2d3e4f5a6b', state: 'removed' },
  ],
}

describe('node API bodies', () => {
  it('accepts the docs/api.md §7.1 hello and §7.3 status examples', () => {
    expect(nodeHelloBody.parse(HELLO).containers).toHaveLength(1)
    expect(nodeStatusBody.parse(STATUS).workers).toHaveLength(5)
  })

  it('accepts the null lists a Go daemon sends for empty slices', () => {
    expect(nodeHelloBody.parse({ ...HELLO, containers: null }).containers).toBeNull()
    expect(nodeStatusBody.parse({ ...STATUS, workers: null }).workers).toBeNull()
  })

  it('rejects unknown keys, unknown states and DinD modes', () => {
    expect(nodeHelloBody.safeParse({ ...HELLO, extra: 1 }).success).toBe(false)
    expect(nodeHelloBody.safeParse({ ...HELLO, info: { ...HELLO.info, dindMode: 'rootless' } }).success).toBe(false)
    expect(nodeStatusBody.safeParse({ ...STATUS, workers: [{ workerId: 'x', state: 'exploded' }] }).success).toBe(false)
    expect(nodeStatusBody.safeParse({ ...STATUS, workers: [{ workerId: 'x', state: 'error', error: { code: 'other', message: '' } }] }).success).toBe(false)
  })

  it('parses the assignments query and caps wait at 60 s', () => {
    expect(nodeAssignmentsQuery.parse({ rev: '41', wait: '25' })).toEqual({ rev: 41, wait: 25 })
    expect(nodeAssignmentsQuery.parse({ rev: '0', wait: '0' })).toEqual({ rev: 0, wait: 0 })
    expect(nodeAssignmentsQuery.safeParse({ wait: '61' }).success).toBe(false)
    expect(nodeAssignmentsQuery.safeParse({ rev: 'x' }).success).toBe(false)
  })

  it('accepts the docs/api.md §7.4 log answer', () => {
    const body = { requestId: '61c0e9a2-3b4d-4e5f-8a6b-7c8d9e0f1a2b', text: 'line\n', bytes: 65536, truncated: true, collectedAt: '2026-10-21T10:06:00.000Z' }
    expect(workerLogsBody.parse(body)).toEqual(body)
    expect(workerLogsBody.safeParse({ ...body, requestId: 'nope' }).success).toBe(false)
  })
})

describe('node administration bodies', () => {
  it('fills the defaults of createNode', () => {
    expect(createNodeBody.parse({ name: 'scan-eu-1' })).toEqual({ name: 'scan-eu-1', pool: 'shared', labels: {} })
    expect(createNodeBody.parse({ name: 'n2', pool: 'gpu', labels: { region: 'eu' }, maxWorkers: 4 })).toEqual({ name: 'n2', pool: 'gpu', labels: { region: 'eu' }, maxWorkers: 4 })
  })

  it('reserves the built-in node name and validates slugs and labels', () => {
    expect(createNodeBody.safeParse({ name: 'builtin' }).success).toBe(false)
    expect(updateNodeBody.safeParse({ name: 'builtin' }).success).toBe(false)
    expect(createNodeBody.safeParse({ name: 'Scan_EU' }).success).toBe(false)
    expect(createNodeBody.safeParse({ name: 'n', labels: { 'Bad Key': 'x' } }).success).toBe(false)
    expect(createNodeBody.safeParse({ name: 'n', labels: { k: 'v'.repeat(64) } }).success).toBe(false)
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, 'v']))
    expect(createNodeBody.safeParse({ name: 'n', labels: tooMany }).success).toBe(false)
  })

  it('requires at least one field in updateNode and allows clearing maxWorkers', () => {
    expect(updateNodeBody.safeParse({}).success).toBe(false)
    expect(updateNodeBody.parse({ maxWorkers: null })).toEqual({ maxWorkers: null })
    expect(updateNodeBody.parse({ cordoned: true })).toEqual({ cordoned: true })
    expect(updateNodeBody.safeParse({ cordoned: true, tokenHash: 'x' }).success).toBe(false)
  })

  it('lets the UI form keep the built-in name for the built-in node only', () => {
    const form = { name: 'builtin', pool: 'shared', labels: {}, maxWorkers: null, cordoned: true }
    expect(nodeFormSchema(true).safeParse(form).success).toBe(true)
    expect(nodeFormSchema(false).safeParse(form).success).toBe(false)
    expect(nodeFormSchema(true).safeParse({ ...form, name: 'renamed' }).success).toBe(false)
    expect(nodeFormSchema(false).safeParse({ ...form, name: 'scan-eu-1' }).success).toBe(true)
  })

  it('accepts event type prefixes', () => {
    expect(listNodeEventsQuery.parse({ type: 'worker.' })).toEqual({ type: 'worker.' })
    expect(listNodeEventsQuery.parse({ type: 'node.instanceConflict' })).toEqual({ type: 'node.instanceConflict' })
    expect(listNodeEventsQuery.safeParse({ type: '$where' }).success).toBe(false)
  })
})
