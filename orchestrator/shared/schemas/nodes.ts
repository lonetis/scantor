import { z } from 'zod'
import { dnsServerProblem, dnsServerProblemMessage } from '../utils/dns-servers'
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
  /** `daemonConfig` adds every node's daemon configuration (docs/api.md §4.17). */
  include: z.enum(['daemonConfig']).optional(),
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

// ── daemon overrides (docs/api.md §4.17, docs/nodes.md §6.12) ───────────────

/**
 * Bounds of the overridable daemon configuration keys. They restate schemas/daemon-overrides.json (the source shared
 * with the Go daemon); test/shared/daemon-overrides.test.ts keeps both in sync.
 */
export const DAEMON_OVERRIDE_BOUNDS = {
  maxWorkers: { min: 1, max: 100_000 },
  pidsLimit: { min: 1, max: 1_073_741_824 },
  shmSizeBytes: { min: 1_048_576, max: 68_719_476_736 },
  nofile: { min: 1, max: 1_073_741_824 },
  workerLogMaxSizeBytes: { min: 1, max: 17_179_869_184 },
  workerLogMaxFiles: { min: 1, max: 1000 },
  imageRetentionMs: { min: 0, max: 31_536_000_000 },
  pullTimeoutMs: { min: 1000, max: 86_400_000 },
  'dns.cacheSizeBytes': { min: 16_777_216, max: 68_719_476_736 },
  'dns.maxLookups': { min: 1, max: 20_000 },
  'dns.upstreamQps': { min: 0, max: 1_000_000 },
  'dns.authoritativeQps': { min: 0, max: 1_000_000 },
} as const

export const DAEMON_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export const RESOLVER_MODES = ['recursive', 'iterative', 'disabled'] as const
export const RESOLVER_STATES = ['starting', 'ready', 'degraded', 'unreachable', 'failed', 'disabled'] as const

/** The dotted override keys (the vocabulary of SCANTOR_NODE_OVERRIDES). */
export const DAEMON_OVERRIDE_KEYS = [
  'maxWorkers',
  'pidsLimit',
  'shmSizeBytes',
  'nofile',
  'workerLogMaxSizeBytes',
  'workerLogMaxFiles',
  'imageRetentionMs',
  'pullTimeoutMs',
  'logLevel',
  'dns.mode',
  'dns.upstreams',
  'dns.rootServers',
  'dns.localDomains',
  'dns.cacheSizeBytes',
  'dns.maxLookups',
  'dns.upstreamQps',
  'dns.authoritativeQps',
] as const
export type DaemonOverrideKey = (typeof DAEMON_OVERRIDE_KEYS)[number]

const DOMAIN = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/

const bounded = (key: keyof typeof DAEMON_OVERRIDE_BOUNDS) => z.number().int().min(DAEMON_OVERRIDE_BOUNDS[key].min).max(DAEMON_OVERRIDE_BOUNDS[key].max)
/**
 * A DNS server of a daemon override (shared/utils/dns-servers.ts): an IP address, ip:port or [v6]:port that is unicast,
 * without zone and outside the ranges only the node environment may name; `host` (the host nameservers) where allowed.
 */
const overrideDnsServer = (allowHost: boolean) =>
  z
    .string()
    .trim()
    .max(64)
    .superRefine((value, ctx) => {
      if (allowHost && value === 'host') return
      const problem = dnsServerProblem(value, { override: true })
      if (problem) ctx.addIssue({ code: 'custom', message: dnsServerProblemMessage(problem, allowHost) })
    })
const dnsServer = () => overrideDnsServer(false)
const dnsServerOrHost = () => overrideDnsServer(true)
const domainName = () =>
  z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => v.replace(/\.$/, ''))
    .pipe(z.string().regex(DOMAIN, 'must be a domain name'))

/** The values of daemon overrides (every key optional; `dns` nested). */
export const daemonOverrideValues = z.strictObject({
  maxWorkers: bounded('maxWorkers').optional(),
  pidsLimit: bounded('pidsLimit').optional(),
  shmSizeBytes: bounded('shmSizeBytes').optional(),
  nofile: bounded('nofile').optional(),
  workerLogMaxSizeBytes: bounded('workerLogMaxSizeBytes').optional(),
  workerLogMaxFiles: bounded('workerLogMaxFiles').optional(),
  imageRetentionMs: bounded('imageRetentionMs').optional(),
  pullTimeoutMs: bounded('pullTimeoutMs').optional(),
  logLevel: z.enum(DAEMON_LOG_LEVELS).optional(),
  dns: z
    .strictObject({
      mode: z.enum(RESOLVER_MODES).optional(),
      upstreams: z.array(dnsServerOrHost()).min(1).max(16).optional(),
      rootServers: z.array(dnsServer()).max(16).optional(),
      localDomains: z.array(domainName()).max(64).optional(),
      cacheSizeBytes: bounded('dns.cacheSizeBytes').optional(),
      maxLookups: bounded('dns.maxLookups').optional(),
      upstreamQps: bounded('dns.upstreamQps').optional(),
      authoritativeQps: bounded('dns.authoritativeQps').optional(),
    })
    .optional(),
})
export type DaemonOverrideValuesInput = z.infer<typeof daemonOverrideValues>

/**
 * Body of updateNodeDaemonOverrides: a JSON merge patch (RFC 7396) of the daemon overrides. `null` removes an override
 * (`dns: null` every dns override); at least one key.
 */
export const updateNodeDaemonOverridesBody = z
  .strictObject({
    maxWorkers: bounded('maxWorkers').nullable().optional(),
    pidsLimit: bounded('pidsLimit').nullable().optional(),
    shmSizeBytes: bounded('shmSizeBytes').nullable().optional(),
    nofile: bounded('nofile').nullable().optional(),
    workerLogMaxSizeBytes: bounded('workerLogMaxSizeBytes').nullable().optional(),
    workerLogMaxFiles: bounded('workerLogMaxFiles').nullable().optional(),
    imageRetentionMs: bounded('imageRetentionMs').nullable().optional(),
    pullTimeoutMs: bounded('pullTimeoutMs').nullable().optional(),
    logLevel: z.enum(DAEMON_LOG_LEVELS).nullable().optional(),
    dns: z
      .strictObject({
        mode: z.enum(RESOLVER_MODES).nullable().optional(),
        upstreams: z.array(dnsServerOrHost()).min(1).max(16).nullable().optional(),
        rootServers: z.array(dnsServer()).max(16).nullable().optional(),
        localDomains: z.array(domainName()).max(64).nullable().optional(),
        cacheSizeBytes: bounded('dns.cacheSizeBytes').nullable().optional(),
        maxLookups: bounded('dns.maxLookups').nullable().optional(),
        upstreamQps: bounded('dns.upstreamQps').nullable().optional(),
        authoritativeQps: bounded('dns.authoritativeQps').nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), 'at least one field is required')
export type UpdateNodeDaemonOverridesBody = z.infer<typeof updateNodeDaemonOverridesBody>

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

// ── daemon-reported sub-reports (docs/nodes.md §7.1) ────────────────────────
// `daemonConfig` and `info.resolver` of hello and status are parsed apart from the heartbeat
// (server/services/nodes/reports.ts): the strict bodies take them as unknown, and a sub-report above
// NODE_SUB_REPORT_MAX_BYTES or failing these lenient schemas is stored as null, never a 400. Lenient: unknown keys
// are stripped, null lists of a Go daemon become empty ones, and every key is optional except daemonConfig.values and
// the resolver's mode and state (a new daemon-reported key is always optional, so a daemon of the previous minor
// release keeps its report). The list limits (64 CA certificates, 256 egress deny entries, 64 warnings of at most 1024
// characters) are at least the caps of the daemon's report (internal/node settings.go), so the report of every
// configuration a daemon accepts fits.

/**
 * The largest daemon-reported sub-report (its JSON) the orchestrator stores: room for a daemon configuration with
 * every list at its limit (certificates, deny list, 64 local domains of 253 characters, warnings).
 */
export const NODE_SUB_REPORT_MAX_BYTES = 65_536
const DAEMON_CONFIG_SOURCES = ['env', 'default', 'override'] as const
/** A node resolver error is a code of a fixed vocabulary (docs/nodes.md §6.11), never log text. */
const RESOLVER_ERROR_CODE = /^[a-z][A-Za-z0-9]{0,63}$/
/** A resolver detail holds addresses and numbers: no quotes, brackets of markup or control characters. */
const RESOLVER_DETAIL = /^[A-Za-z0-9 .:,;/[\]()=%+_-]*$/
const OVERRIDE_KEY = /^[a-z][A-Za-z0-9]{0,63}(\.[a-z][A-Za-z0-9]{0,63})?$/

const reportedInt = () => byteCount().optional()
// `.optional()` outside the transform keeps an absent key absent (and never stored as null).
const reportedList = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .nullable()
    .transform((list) => list ?? [])
    .optional()

/** A tree of the daemon configuration keys with one leaf schema (sources, rejected messages). */
function daemonConfigTree<T extends z.ZodType>(leaf: T) {
  const optional = leaf.optional()
  return z.object({
    url: optional,
    builtIn: optional,
    maxWorkers: optional,
    dind: optional,
    egressDeny: optional,
    allowUnisolatedNetworks: optional,
    allowInsecureTransport: optional,
    caCertificates: optional,
    pidsLimit: optional,
    shmSizeBytes: optional,
    nofile: optional,
    workerLogMaxSizeBytes: optional,
    workerLogMaxFiles: optional,
    imageRetentionMs: optional,
    pullTimeoutMs: optional,
    logLevel: optional,
    logFormat: optional,
    overrides: optional,
    dns: z
      .object({
        mode: optional,
        upstreams: optional,
        rootServers: optional,
        localDomains: optional,
        cacheSizeBytes: optional,
        maxLookups: optional,
        upstreamQps: optional,
        authoritativeQps: optional,
      })
      .optional(),
  })
}

/** The values of a reported daemon configuration (docs/nodes.md §6.12). */
export const reportedDaemonConfigValues = z.object({
  url: z.string().max(2048).optional(),
  builtIn: z.boolean().optional(),
  maxWorkers: reportedInt(),
  dind: z.enum(DIND_MODES).optional(),
  egressDeny: reportedList(z.string().max(64), 256),
  allowUnisolatedNetworks: z.boolean().optional(),
  allowInsecureTransport: z.boolean().optional(),
  caCertificates: reportedList(z.object({ subject: z.string().max(1024), sha256: z.string().max(64), notAfter: z.iso.datetime({ offset: true }) }), 64),
  pidsLimit: reportedInt(),
  shmSizeBytes: reportedInt(),
  nofile: reportedInt(),
  workerLogMaxSizeBytes: reportedInt(),
  workerLogMaxFiles: reportedInt(),
  imageRetentionMs: reportedInt(),
  pullTimeoutMs: reportedInt(),
  logLevel: z.enum(DAEMON_LOG_LEVELS).optional(),
  logFormat: z.enum(['json', 'text']).optional(),
  // A Go daemon sends null for an unset allow-list; nothing is allowed then.
  overrides: z
    .union([z.literal('all'), z.literal('none'), z.array(z.string().regex(OVERRIDE_KEY)).max(64)])
    .nullable()
    .transform((value) => value ?? 'none')
    .optional(),
  dns: z
    .object({
      mode: z.enum(RESOLVER_MODES).optional(),
      upstreams: reportedList(z.string().max(64), 64),
      rootServers: reportedList(z.string().max(64), 64),
      localDomains: reportedList(z.string().max(253), 256),
      cacheSizeBytes: reportedInt(),
      maxLookups: reportedInt(),
      upstreamQps: reportedInt(),
      authoritativeQps: reportedInt(),
    })
    .optional(),
})
export type ReportedDaemonConfigValues = z.output<typeof reportedDaemonConfigValues>

/** `daemonConfig` of hello and status: the daemon configuration of the reporting instance. */
export const daemonConfigReport = z.object({
  appliedOverridesRev: byteCount().optional().default(0),
  values: reportedDaemonConfigValues,
  sources: daemonConfigTree(z.enum(DAEMON_CONFIG_SOURCES))
    .nullish()
    .transform((tree) => tree ?? {}),
  warnings: z
    .array(z.string().max(1024))
    .max(64)
    .nullish()
    .transform((list) => list ?? []),
  rejected: daemonConfigTree(z.string().max(1024))
    .nullish()
    .transform((tree) => tree ?? {}),
})
export type DaemonConfigReport = z.output<typeof daemonConfigReport>

const resolverCounter = () => byteCount().default(0)
const resolverRate = () => z.number().min(0).max(1e15).default(0)

/** `info.resolver` of hello and status: the state of the node resolver (docs/nodes.md §6.11). */
export const nodeResolverReport = z.object({
  mode: z.enum(RESOLVER_MODES),
  state: z.enum(RESOLVER_STATES),
  address: z.string().max(64).optional(),
  kept: z.boolean().default(false),
  error: z
    .string()
    .regex(RESOLVER_ERROR_CODE)
    .nullish()
    .transform((code) => code ?? null),
  detail: z.string().max(256).regex(RESOLVER_DETAIL).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  spec: z.string().max(80).optional(),
  ipv6: z.boolean().default(false),
  upstreamOk: z.boolean().default(false),
  stats: z
    .object({
      queries: resolverCounter(),
      cacheHits: resolverCounter(),
      lookups: resolverCounter(),
      failures: resolverCounter(),
      inflight: resolverCounter(),
      qps: resolverRate(),
      conntrackUsed: resolverRate(),
    })
    .nullish()
    .transform((stats) => stats ?? null),
})
export type NodeResolverReportInput = z.output<typeof nodeResolverReport>

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
    networkIsolated: z.boolean().optional(),
    /** nodeResolverReport, parsed apart (above) */
    resolver: z.unknown().optional(),
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
  /** daemonConfigReport, parsed apart (above) */
  daemonConfig: z.unknown().optional(),
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
    networkIsolated: z.boolean().optional(),
    /** nodeResolverReport, parsed apart (above) */
    resolver: z.unknown().optional(),
  }),
  workers: z.array(nodeWorkerReport).max(10_000).nullable().default([]),
  /** daemonConfigReport, parsed apart (above) */
  daemonConfig: z.unknown().optional(),
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
