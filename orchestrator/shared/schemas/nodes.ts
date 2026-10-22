import { z } from 'zod'
import { DIND_MODES, NODE_STATES, WORKER_STATES } from '../utils/enums'
import { NODE_LABEL_KEY_PATTERN, NODE_LABEL_VALUE_MAX_LENGTH, NODE_LABELS_MAX, SLUG_PATTERN } from '../utils/slug'
import { cursorQuery, MAX_PAGE_LIMIT, qInt, qList } from './common'

// Request schemas of the `nodes` tag (admin, docs/api.md §4.17) and of the node API (`/api/node/*`, docs/api.md §7).
// Every object is strict: unknown keys are rejected (docs/api.md §1.5).

/** Node names and pools: lowercase slugs of 1–64 characters (docs/data-model.md §4.8). */
export const nodeSlug = () => z.string().trim().regex(SLUG_PATTERN, 'must be 1–64 lowercase letters, digits or hyphens')

/** The name of the built-in node record; remote nodes can never take it. */
export const BUILTIN_NODE_NAME = 'builtin'

export const nodeLabels = () =>
  z
    .record(
      z.string().regex(NODE_LABEL_KEY_PATTERN, 'label keys are lowercase letters, digits, ".", "_" or "-" (1–63 characters)'),
      z.string().max(NODE_LABEL_VALUE_MAX_LENGTH),
    )
    .refine((labels) => Object.keys(labels).length <= NODE_LABELS_MAX, `at most ${NODE_LABELS_MAX} labels`)

/** Admin override of a node's worker capacity; null removes it. */
export const nodeMaxWorkers = () => z.number().int().min(0).max(100_000)

// ── admin routes (docs/api.md §4.17) ────────────────────────────────────────

export const nodeIdParams = z.strictObject({ nodeId: z.uuid() })

export const listNodesQuery = z.strictObject({
  state: z.enum(NODE_STATES).optional(),
  pool: nodeSlug().optional(),
})
export type ListNodesQuery = z.infer<typeof listNodesQuery>

/** A remote node's name: a slug other than the built-in node's reserved name. */
const remoteNodeName = () => nodeSlug().refine((name) => name !== BUILTIN_NODE_NAME, `"${BUILTIN_NODE_NAME}" is reserved for the built-in node`)

export const createNodeBody = z.strictObject({
  name: remoteNodeName(),
  pool: nodeSlug().default('shared'),
  labels: nodeLabels().default({}),
  maxWorkers: nodeMaxWorkers().nullable().optional(),
})
export type CreateNodeBody = z.input<typeof createNodeBody>

export const updateNodeBody = z
  .strictObject({
    name: remoteNodeName().optional(),
    pool: nodeSlug().optional(),
    labels: nodeLabels().optional(),
    maxWorkers: nodeMaxWorkers().nullable().optional(),
    cordoned: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'at least one field is required')
export type UpdateNodeBody = z.infer<typeof updateNodeBody>

/**
 * The node form of the UI (create and edit): every editable field plus the cordon switch. The built-in node keeps its
 * reserved name; a remote node can never take it.
 */
export function nodeFormSchema(builtIn: boolean) {
  return z.object({
    name: builtIn ? z.literal(BUILTIN_NODE_NAME) : remoteNodeName(),
    pool: nodeSlug(),
    labels: nodeLabels(),
    maxWorkers: nodeMaxWorkers().nullable(),
    cordoned: z.boolean(),
  })
}
export type NodeForm = z.infer<ReturnType<typeof nodeFormSchema>>

export const listNodeWorkersQuery = z.strictObject({
  state: qList(z.enum(WORKER_STATES), WORKER_STATES.length).optional(),
  cursor: cursorQuery.optional(),
  limit: qInt(1, MAX_PAGE_LIMIT).optional(),
})

/** `type` is an exact event type, or a prefix ending in "." (for example `worker.`). */
export const listNodeEventsQuery = z.strictObject({
  type: z.string().regex(/^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)*\.?$/, 'must be an event type or a prefix ending in "."').max(64).optional(),
  cursor: cursorQuery.optional(),
  limit: qInt(1, MAX_PAGE_LIMIT).optional(),
})

// ── node API (docs/api.md §7, docs/nodes.md) ────────────────────────────────

const INSTANCE_ID = /^[A-Za-z0-9:._-]{1,200}$/
const VERSION = z.string().min(1).max(64)
const NODE_REPORTED_WORKER_STATES = ['pulling', 'starting', 'running', 'backoff', 'stopping', 'removed', 'error'] as const
const NODE_WORKER_ERROR_CODES = ['imagePullFailed', 'createFailed', 'platformMismatch'] as const
/** A worker log tail inside a status report (docs/nodes.md §6.5: at most 4 KiB, allowing for UTF-8 slack). */
const LOG_TAIL_MAX = 8192
/** The largest on-demand tail a user can request (docs/api.md §4.13 getWorkerLogs). */
export const WORKER_LOG_TAIL_MAX_BYTES = 262_144

export const instanceIdSchema = z.string().regex(INSTANCE_ID, 'must be "<engine id>:<nonce>"')

const count = (max: number) => z.number().int().min(0).max(max)
const byteCount = () => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

export const nodeHelloBody = z.strictObject({
  instanceId: instanceIdSchema,
  version: VERSION,
  info: z.strictObject({
    hostname: z.string().max(253),
    os: z.string().min(1).max(32),
    arch: z.string().min(1).max(32),
    kernel: z.string().max(256),
    dockerVersion: z.string().max(64),
    cpus: count(100_000),
    memoryBytes: byteCount(),
    diskFreeBytes: byteCount(),
    dindMode: z.enum(DIND_MODES),
    maxWorkers: count(100_000),
    egressDenyApplied: z.boolean(),
  }),
  containers: z
    .array(
      z.strictObject({
        workerId: z.string().max(64),
        containerId: z.string().max(128),
        state: z.string().max(32),
        specHash: z.string().max(80),
      }),
    )
    .max(10_000)
    .nullable()
    .default([]),
})
export type NodeHelloBody = z.infer<typeof nodeHelloBody>

export const nodeAssignmentsQuery = z.strictObject({
  rev: qInt(-1_000_000_000_000, Number.MAX_SAFE_INTEGER).optional(),
  wait: qInt(0, 60).optional(),
})

const isoTime = () => z.iso.datetime({ offset: true })

export const nodeWorkerReport = z.strictObject({
  workerId: z.string().max(64),
  state: z.enum(NODE_REPORTED_WORKER_STATES),
  containerId: z.string().max(128).optional(),
  startedAt: isoTime().optional(),
  restarts: count(1_000_000_000).optional(),
  applied: z
    .strictObject({
      processes: count(100_000),
      nanoCpus: byteCount(),
      memoryBytes: byteCount(),
    })
    .optional(),
  lastExit: z
    .strictObject({
      exitCode: z.number().int().min(-1_000_000).max(1_000_000),
      oomKilled: z.boolean(),
      at: isoTime(),
      logTail: z.string().max(LOG_TAIL_MAX),
    })
    .optional(),
  nextRestartAt: isoTime().optional(),
  pull: z.strictObject({ image: z.string().max(1024), startedAt: isoTime() }).optional(),
  error: z.strictObject({ code: z.enum(NODE_WORKER_ERROR_CODES), message: z.string().max(4096) }).optional(),
})
export type NodeWorkerReport = z.infer<typeof nodeWorkerReport>

export const nodeStatusBody = z.strictObject({
  instanceId: instanceIdSchema,
  appliedRev: z.number().int().min(-1_000_000_000_000).max(Number.MAX_SAFE_INTEGER),
  clockOffsetMs: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  info: z.strictObject({
    version: VERSION,
    cpus: count(100_000),
    memoryBytes: byteCount(),
    diskFreeBytes: byteCount(),
    dindMode: z.enum(DIND_MODES),
    maxWorkers: count(100_000),
    egressDenyApplied: z.boolean(),
  }),
  workers: z.array(nodeWorkerReport).max(10_000).nullable().default([]),
})
export type NodeStatusBody = z.infer<typeof nodeStatusBody>

export const workerIdParams = z.strictObject({ workerId: z.uuid() })

export const workerLogsBody = z.strictObject({
  requestId: z.uuid(),
  text: z.string().max(2 * WORKER_LOG_TAIL_MAX_BYTES),
  bytes: count(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean(),
  collectedAt: isoTime(),
})
export type WorkerLogsBody = z.infer<typeof workerLogsBody>
