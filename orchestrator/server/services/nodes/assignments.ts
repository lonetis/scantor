import { EventEmitter } from 'node:events'
import type { ChangeStream } from 'mongodb'
import { ACTIVE_WORKER_STATES, type WorkerState } from '#shared/utils/enums'
import type { NodeDoc, RevisionDoc, ScanDoc, WorkerDoc } from '../../types/documents'
import { shutdownSignal } from '../../utils/boot'
import type { Config } from '../../utils/config'
import { type Logger, useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import { mintWorkerToken } from '../../utils/worker-tokens'
import { endpointUrls } from './profile'

// The desired worker set of a node (docs/api.md §7.2, docs/nodes.md §5.3): `GET /api/node/assignments?rev&wait`
// returns at once when `nodes.assignmentsRev > rev`, otherwise after `wait` seconds; the response is always the
// complete set, computed from `workers` (states assigned … backoff) and the open on-demand log requests.
//
// Waking: notifyAssignmentsChanged bumps `assignmentsRev` and wakes waiting long-polls of this process at once; a
// change stream on `nodes` wakes them when another process (for example a separate reconciler component) bumped
// the revision. When the change stream fails, waits poll the revision every second.

export const MEMORY_OVERHEAD_BYTES = 256 * 1024 * 1024
const MIB = 1024 * 1024
/** Assignment states: in the desired set (draining workers leave it, so the daemon stops them). */
export const ASSIGNED_WORKER_STATES = ['assigned', 'pulling', 'starting', 'running', 'backoff'] as const satisfies readonly WorkerState[]
/** Log requests older than this are no longer handed to the daemon. */
export const LOG_REQUEST_TTL_MS = 2 * 60_000
const POLL_FALLBACK_MS = 1000

export interface Assignment {
  workerId: string
  scanId: string
  userId: string
  role: WorkerDoc['role']
  specHash: string
  image: string
  baseImage: string | null
  processes: number
  resources: { nanoCpus: number; memoryBytes: number }
  privileged: boolean
  dindMode: 'sysbox' | 'privileged' | null
  capAdd: string[]
  env: { SCANTOR_URL: string; SCANTOR_WORKER_TOKEN: string }
}

export interface LogRequest {
  requestId: string
  workerId: string
  tailBytes: number
}

export interface NodeAssignmentsResponse {
  serverTime: number
  rev: number
  workers: Assignment[]
  logRequests: LogRequest[]
}

/** Container limits of an assignment (docs/api.md §7.2). */
export function containerResources(processes: number, resources: { cpus: number; memoryMiB: number }): { nanoCpus: number; memoryBytes: number } {
  return {
    nanoCpus: Math.round(processes * resources.cpus * 1e9),
    memoryBytes: processes * resources.memoryMiB * MIB + MEMORY_OVERHEAD_BYTES,
  }
}

/**
 * The pullable base image reference `<repository>@<digest>`, or null when the base image is not pullable from a
 * registry (dev builds use local images without a registry host).
 */
export function pullableBaseImage(baseImage: RevisionDoc['baseImage']): string | null {
  if (!baseImage?.ref || !/^sha256:[0-9a-f]{64}$/.test(baseImage.digest)) return null
  const withoutDigest = baseImage.ref.split('@')[0]!
  const slash = withoutDigest.indexOf('/')
  if (slash < 0) return null
  const host = withoutDigest.slice(0, slash)
  if (!host.includes('.') && !host.includes(':') && host !== 'localhost') return null
  // Strip a tag (a colon after the last slash) but keep a registry port.
  const lastSlash = withoutDigest.lastIndexOf('/')
  const colon = withoutDigest.indexOf(':', lastSlash)
  const repository = colon > 0 ? withoutDigest.slice(0, colon) : withoutDigest
  return `${repository}@${baseImage.digest}`
}

export interface AssignmentContext {
  node: Pick<NodeDoc, '_id' | 'endpointProfile'>
  config: Pick<Config, 'internalUrl' | 'publicUrl' | 'amqpInternalUrl' | 'amqpPublicUrl' | 'registryPort' | 'registryPublicHost' | 'workerCapAdd'>
  /** base image by scan id (null when unknown or not pullable) */
  baseImageOf: (scanId: string) => string | null
  /** mints the worker token of a placed worker */
  workerToken: (worker: WorkerDoc) => string
}

/** One assignment from a placed worker document. */
export function toAssignment(worker: WorkerDoc, ctx: AssignmentContext): Assignment {
  const urls = endpointUrls(ctx.node.endpointProfile, ctx.config)
  const processes = Math.max(1, worker.processes.assigned)
  return {
    workerId: worker._id,
    scanId: worker.scanId,
    userId: worker.userId,
    role: worker.role,
    specHash: worker.spec.specHash,
    image: `${urls.registryHost}/${worker.spec.repository}@${worker.spec.digest}`,
    baseImage: ctx.baseImageOf(worker.scanId),
    processes,
    resources: containerResources(processes, worker.spec.resources),
    privileged: worker.spec.privileged,
    dindMode: worker.spec.dindMode ?? null,
    capAdd: [...ctx.config.workerCapAdd],
    env: { SCANTOR_URL: urls.apiUrl, SCANTOR_WORKER_TOKEN: ctx.workerToken(worker) },
  }
}

/** Open log requests of a node's workers (requested within LOG_REQUEST_TTL_MS and not answered yet). */
export function openLogRequests(workers: WorkerDoc[], now: Date): LogRequest[] {
  const requests: LogRequest[] = []
  for (const worker of workers) {
    const logs = worker.logs
    if (!logs || logs.collectedAt || now.getTime() - logs.requestedAt.getTime() > LOG_REQUEST_TTL_MS) continue
    requests.push({ requestId: logs.requestId, workerId: worker._id, tailBytes: logs.tailBytes })
  }
  return requests
}

// ── base image lookup (immutable per scan, cached) ──────────────────────────

const BASE_IMAGE_CACHE_MAX = 2000
const baseImageCache = new Map<string, string | null>()

async function baseImagesOf(scanIds: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>()
  const missing = scanIds.filter((id) => {
    if (!baseImageCache.has(id)) return true
    result.set(id, baseImageCache.get(id) ?? null)
    return false
  })
  if (missing.length === 0) return result
  const { scans, revisions } = useCollections()
  const scanDocs = await scans.find({ _id: { $in: missing } }, { projection: { _id: 1, 'revision.id': 1 } }).toArray()
  const revisionIds = [...new Set(scanDocs.map((scan: Pick<ScanDoc, '_id' | 'revision'>) => scan.revision.id))]
  const revisionDocs = await revisions.find({ _id: { $in: revisionIds } }, { projection: { _id: 1, baseImage: 1 } }).toArray()
  const byRevision = new Map(revisionDocs.map((revision) => [revision._id, pullableBaseImage(revision.baseImage)]))
  for (const scan of scanDocs) {
    const image = byRevision.get(scan.revision.id) ?? null
    result.set(scan._id, image)
    if (byRevision.has(scan.revision.id)) {
      if (baseImageCache.size >= BASE_IMAGE_CACHE_MAX) baseImageCache.delete(baseImageCache.keys().next().value!)
      baseImageCache.set(scan._id, image)
    }
  }
  return result
}

/** The complete desired set of a node right now. */
export async function buildNodeAssignments(node: NodeDoc, config: AssignmentContext['config'], now = new Date()): Promise<NodeAssignmentsResponse> {
  const { workers } = useCollections()
  const active = await workers.find({ nodeId: node._id, state: { $in: [...ACTIVE_WORKER_STATES] } }).toArray()
  const assigned = active.filter((worker) => (ASSIGNED_WORKER_STATES as readonly string[]).includes(worker.state))
  const baseImages = await baseImagesOf([...new Set(assigned.map((worker) => worker.scanId))])
  const ctx: AssignmentContext = {
    node,
    config,
    baseImageOf: (scanId) => baseImages.get(scanId) ?? null,
    workerToken: mintWorkerToken,
  }
  const sorted = [...assigned].sort((a, b) => (a.assignedAt?.getTime() ?? 0) - (b.assignedAt?.getTime() ?? 0) || a._id.localeCompare(b._id))
  return {
    serverTime: now.getTime(),
    rev: node.assignmentsRev,
    workers: sorted.map((worker) => toAssignment(worker, ctx)),
    logRequests: openLogRequests(active, now),
  }
}

// ── revision bumps and waiting ──────────────────────────────────────────────

/** How long a failed change stream is left alone before it is opened again. */
const STREAM_RETRY_MS = 5000

/** Wakes of one node for one long-poll. A wake that arrives while the poll reads the node is not lost. */
export interface WakeSubscription {
  /** Resolves at the next wake (or at once when one arrived since the last call), at the deadline or on abort. */
  next(deadline: number, signal: AbortSignal): Promise<void>
  close(): void
}

export class AssignmentWaiters {
  private readonly emitter = new EventEmitter()
  private stream: ChangeStream | null = null
  private streaming = false
  private streamRetryAt = 0

  constructor(
    private readonly log: Logger,
    /** opens the change stream of `nodes` revision bumps; null disables cross-process wakes (tests) */
    private readonly openStream: (() => ChangeStream) | null = () =>
      useCollections().nodes.watch([{ $match: { operationType: 'update', 'updateDescription.updatedFields.assignmentsRev': { $exists: true } } }]),
  ) {
    this.emitter.setMaxListeners(0)
  }

  wake(nodeId: string): void {
    this.emitter.emit(nodeId)
  }

  /** Whether wakes from other processes arrive (otherwise waits re-read the revision every second). */
  get crossProcess(): boolean {
    return this.streaming
  }

  private ensureStream(): void {
    if (this.stream || !this.openStream || Date.now() < this.streamRetryAt) return
    const failed = (error: unknown) => {
      this.log.warn('assignments change stream failed; long-polls re-read the revision every second', { err: error })
      this.streaming = false
      this.streamRetryAt = Date.now() + STREAM_RETRY_MS
      const stream = this.stream
      this.stream = null
      void stream?.close().catch(() => undefined)
    }
    try {
      const stream = this.openStream()
      this.stream = stream
      this.streaming = true
      stream.on('change', (change: { documentKey?: { _id?: unknown } }) => {
        const id = change.documentKey?._id
        if (typeof id === 'string') this.wake(id)
      })
      stream.on('error', failed)
    } catch (error) {
      failed(error)
    }
  }

  subscribe(nodeId: string): WakeSubscription {
    this.ensureStream()
    let woken = false
    let resolveWait: (() => void) | null = null
    const onWake = () => {
      woken = true
      resolveWait?.()
    }
    this.emitter.on(nodeId, onWake)
    return {
      next: async (deadline, signal) => {
        this.ensureStream()
        if (woken) {
          woken = false
          return
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0 || signal.aborted) return
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', done)
            resolveWait = null
            resolve()
          }
          const timer = setTimeout(done, this.streaming ? remaining : Math.min(remaining, POLL_FALLBACK_MS))
          resolveWait = done
          signal.addEventListener('abort', done, { once: true })
        })
        woken = false
      },
      close: () => {
        this.emitter.off(nodeId, onWake)
        resolveWait?.()
      },
    }
  }

  async close(): Promise<void> {
    const stream = this.stream
    this.stream = null
    this.streaming = false
    await stream?.close().catch(() => undefined)
  }
}

let waiters: AssignmentWaiters | null = null

function useWaiters(): AssignmentWaiters {
  waiters ??= new AssignmentWaiters(useLogger('nodes'))
  return waiters
}

/**
 * Bumps the node's assignments revision (docs/data-model.md §4.8: incremented on every change of the desired set
 * or log requests) and wakes its long-polls. Placement calls it after changing the desired workers of a node.
 */
export async function notifyAssignmentsChanged(nodeId: string): Promise<void> {
  await useCollections().nodes.updateOne({ _id: nodeId }, { $inc: { assignmentsRev: 1 }, $set: { updatedAt: new Date() } })
  useWaiters().wake(nodeId)
}

export interface WaitForAssignmentsOptions {
  rev: number
  waitMs: number
  signal: AbortSignal
}

/**
 * Holds a long-poll until the node's revision exceeds `rev`, the wait elapses or the orchestrator begins to stop (so
 * the shutdown does not wait for the long-polls); returns the node document.
 */
export async function waitForAssignments(nodeId: string, options: WaitForAssignmentsOptions): Promise<NodeDoc | null> {
  const { nodes } = useCollections()
  const deadline = Date.now() + options.waitMs
  const signal = AbortSignal.any([options.signal, shutdownSignal()])
  // Once the shutdown began, answer without subscribing: the waiters and their change stream are being closed.
  if (signal.aborted) return nodes.findOne({ _id: nodeId })
  // Subscribe before reading, so a bump between the read and the wait still ends the wait.
  const subscription = useWaiters().subscribe(nodeId)
  try {
    for (;;) {
      const node = await nodes.findOne({ _id: nodeId })
      if (!node || node.assignmentsRev > options.rev || Date.now() >= deadline || signal.aborted) return node
      await subscription.next(deadline, signal)
    }
  } finally {
    subscription.close()
  }
}

export async function closeAssignmentWaiters(): Promise<void> {
  await waiters?.close()
  waiters = null
}
