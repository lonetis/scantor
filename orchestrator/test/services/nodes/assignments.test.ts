import { describe, expect, it } from 'vitest'
import {
  AssignmentWaiters,
  type AssignmentContext,
  containerResources,
  openLogRequests,
  pullableBaseImage,
  toAssignment,
} from '../../../server/services/nodes/assignments'
import { endpointUrls } from '../../../server/services/nodes/profile'
import { at, DIGEST, NODE_ID, recordingLogger, SCAN_ID, T0, TASK_ID, USER_ID, workerDoc } from './helpers'

// Assignments (docs/api.md §7.2, docs/nodes.md §5.3, §6.10, docs/architecture.md §8): one entry per placed worker
// with the image by digest on the node's registry host, the container limits, capabilities and the worker
// environment of the node's endpoint profile; plus open log requests.

const W1 = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

const config: AssignmentContext['config'] = {
  internalUrl: 'http://orchestrator:3000',
  publicUrl: 'https://scantor.example.com',
  amqpInternalUrl: 'amqp://rabbitmq:5672',
  amqpPublicUrl: 'amqps://amqp.scantor.example.com:443',
  registryPort: 5000,
  registryPublicHost: 'registry.example.com',
  workerCapAdd: ['NET_BIND_SERVICE', 'NET_RAW'],
}

function context(endpointProfile: 'internal' | 'public', baseImage: string | null = null): AssignmentContext {
  return {
    node: { _id: NODE_ID, endpointProfile },
    config,
    baseImageOf: () => baseImage,
    workerToken: (worker) => `swt_${worker._id}.${'m'.repeat(43)}`,
  }
}

describe('endpoint profiles', () => {
  it('maps the internal profile to compose-internal URLs and the public one to the public URLs', () => {
    expect(endpointUrls('internal', config)).toEqual({ apiUrl: 'http://orchestrator:3000', amqpUrl: 'amqp://rabbitmq:5672', registryHost: 'localhost:5000' })
    expect(endpointUrls('public', config)).toEqual({
      apiUrl: 'https://scantor.example.com',
      amqpUrl: 'amqps://amqp.scantor.example.com:443',
      registryHost: 'registry.example.com',
    })
  })
})

describe('containerResources', () => {
  it('reserves processes × per-process resources plus 256 MiB (the docs/api.md §7.2 example)', () => {
    expect(containerResources(2, { cpus: 1, memoryMiB: 512 })).toEqual({ nanoCpus: 2_000_000_000, memoryBytes: 1_342_177_280 })
    expect(containerResources(3, { cpus: 0.5, memoryMiB: 100 })).toEqual({ nanoCpus: 1_500_000_000, memoryBytes: 3 * 100 * 1024 ** 2 + 256 * 1024 ** 2 })
  })
})

describe('toAssignment', () => {
  it('builds the docs/api.md §7.2 assignment for a remote node', () => {
    const worker = workerDoc(W1, { state: 'running', processes: { desired: 2, assigned: 2, applied: 2, running: 2 } })
    expect(toAssignment(worker, context('public', 'ghcr.io/lonetis/scantor-base-js@sha256:0d1e'))).toEqual({
      workerId: W1,
      scanId: SCAN_ID,
      userId: USER_ID,
      role: 'runner',
      specHash: 'sha256:5d41402abc4b2a76b9719d911017c592',
      image: `registry.example.com/tasks/${TASK_ID}@${DIGEST}`,
      baseImage: 'ghcr.io/lonetis/scantor-base-js@sha256:0d1e',
      processes: 2,
      resources: { nanoCpus: 2_000_000_000, memoryBytes: 1_342_177_280 },
      privileged: false,
      dindMode: null,
      capAdd: ['NET_BIND_SERVICE', 'NET_RAW'],
      env: { SCANTOR_URL: 'https://scantor.example.com', SCANTOR_WORKER_TOKEN: `swt_${W1}.${'m'.repeat(43)}` },
    })
  })

  it('uses the built-in node registry host and internal URL', () => {
    const assignment = toAssignment(workerDoc(W1), context('internal'))
    expect(assignment.image).toBe(`localhost:5000/tasks/${TASK_ID}@${DIGEST}`)
    expect(assignment.env.SCANTOR_URL).toBe('http://orchestrator:3000')
    expect(assignment.baseImage).toBeNull()
    expect(Object.keys(assignment.env).sort()).toEqual(['SCANTOR_URL', 'SCANTOR_WORKER_TOKEN'])
  })

  it('sends the assigned processes, which may differ from the desired ones while resizing', () => {
    const assignment = toAssignment(workerDoc(W1, { processes: { desired: 1, assigned: 4, applied: 4, running: 4 } }), context('public'))
    expect(assignment.processes).toBe(4)
    expect(assignment.resources).toEqual(containerResources(4, { cpus: 1, memoryMiB: 512 }))
  })

  it('carries the DinD mode of privileged workers', () => {
    const worker = workerDoc(W1, { spec: { ...workerDoc(W1).spec, privileged: true, dindMode: 'sysbox' } })
    expect(toAssignment(worker, context('public'))).toMatchObject({ privileged: true, dindMode: 'sysbox' })
  })
})

describe('pullableBaseImage', () => {
  const digest = `sha256:${'0d1e2f3a'.repeat(8)}`

  it('pins a registry image by digest and strips its tag', () => {
    expect(pullableBaseImage({ ref: 'ghcr.io/lonetis/scantor-base-python:1.4.0', digest })).toBe(`ghcr.io/lonetis/scantor-base-python@${digest}`)
    expect(pullableBaseImage({ ref: 'localhost:5000/scantor-base-go:dev', digest })).toBe(`localhost:5000/scantor-base-go@${digest}`)
    expect(pullableBaseImage({ ref: `ghcr.io/lonetis/scantor-base-js@${digest}`, digest })).toBe(`ghcr.io/lonetis/scantor-base-js@${digest}`)
  })

  it('is null for local dev images and unknown digests', () => {
    expect(pullableBaseImage({ ref: 'scantor-base-python:dev', digest })).toBeNull()
    expect(pullableBaseImage({ ref: 'library/scantor-base-python:dev', digest })).toBeNull()
    expect(pullableBaseImage({ ref: 'ghcr.io/lonetis/scantor-base-python:1.4.0', digest: 'sha256:short' })).toBeNull()
    expect(pullableBaseImage(null)).toBeNull()
  })
})

describe('openLogRequests', () => {
  it('lists unanswered requests younger than two minutes', () => {
    const open = workerDoc(W1, { logs: { requestId: '61c0e9a2-3b4d-4e5f-8a6b-7c8d9e0f1a2b', requestedAt: at(-30), tailBytes: 65536, text: null, collectedAt: null, truncated: false } })
    const answered = workerDoc('w2', { logs: { requestId: 'r2', requestedAt: at(-30), tailBytes: 1024, text: 'x', collectedAt: at(-10), truncated: false } })
    const expired = workerDoc('w3', { logs: { requestId: 'r3', requestedAt: at(-300), tailBytes: 1024, text: null, collectedAt: null, truncated: false } })
    expect(openLogRequests([open, answered, expired, workerDoc('w4')], T0)).toEqual([
      { requestId: '61c0e9a2-3b4d-4e5f-8a6b-7c8d9e0f1a2b', workerId: W1, tailBytes: 65536 },
    ])
  })
})

describe('AssignmentWaiters', () => {
  it('does not lose a wake that arrives before the waiter waits', async () => {
    const waiters = new AssignmentWaiters(recordingLogger(), null)
    const subscription = waiters.subscribe(NODE_ID)
    waiters.wake(NODE_ID)
    const started = Date.now()
    await subscription.next(Date.now() + 5000, new AbortController().signal)
    expect(Date.now() - started).toBeLessThan(500)
    subscription.close()
  })

  it('wakes a waiting long-poll and ignores other nodes', async () => {
    const waiters = new AssignmentWaiters(recordingLogger(), null)
    const subscription = waiters.subscribe(NODE_ID)
    let done = false
    const waiting = subscription.next(Date.now() + 60_000, new AbortController().signal).then(() => {
      done = true
    })
    waiters.wake('another-node')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(done).toBe(false)
    waiters.wake(NODE_ID)
    await waiting
    expect(done).toBe(true)
    subscription.close()
  })

  it('re-reads every second without a change stream, and ends on abort', async () => {
    const waiters = new AssignmentWaiters(recordingLogger(), null)
    expect(waiters.crossProcess).toBe(false)
    const subscription = waiters.subscribe(NODE_ID)
    const abort = new AbortController()
    const started = Date.now()
    const waiting = subscription.next(Date.now() + 60_000, abort.signal)
    setTimeout(() => abort.abort(), 30)
    await waiting
    expect(Date.now() - started).toBeLessThan(1000)
    subscription.close()
  })
})
