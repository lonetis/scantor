import type { DindMode, EndpointProfile, NodeState } from '../utils/enums'
import type { IsoDate } from './common'

// Node representations (docs/api.md §2, §4.17; docs/data-model.md §4.8). `Node` collides with the DOM global of
// the same name when auto-imported into app code; import it explicitly or use the `ScantorNode` alias there.

export interface NodeInfo {
  version: string
  hostname: string
  os: string
  arch: string
  kernel: string
  dockerVersion: string
  cpus: number
  memoryBytes: number
  diskFreeBytes: number
  dindMode: DindMode
  maxWorkers: number
  egressDenyApplied: boolean
  networkIsolated?: boolean
  clockOffsetMs?: number
  /** Absent until a daemon that runs a node resolver reported it (docs/nodes.md §6.11). */
  resolver?: NodeResolverReport | null
}

export type ResolverState = 'starting' | 'ready' | 'degraded' | 'unreachable' | 'failed' | 'disabled'
export type ResolverMode = 'recursive' | 'iterative' | 'disabled'

export interface NodeResolverStats {
  queries: number
  cacheHits: number
  lookups: number
  failures: number
  inflight: number
  qps: number
  conntrackUsed: number
}

/** The node resolver part of a node's report (`info.resolver`). `error` is a fixed code, never log text. */
export interface NodeResolverReport {
  mode: ResolverMode
  state: ResolverState
  address?: string
  kept: boolean
  error: string | null
  detail?: string
  since: IsoDate
  spec?: string
  ipv6: boolean
  upstreamOk: boolean
  stats: NodeResolverStats | null
}

export type DaemonConfigSource = 'env' | 'default' | 'override'

export interface DaemonDnsConfig {
  mode: ResolverMode
  upstreams: string[]
  rootServers: string[]
  localDomains: string[]
  cacheSizeBytes: number
  maxLookups: number
  upstreamQps: number
  authoritativeQps: number
}

export interface CaCertificate {
  subject: string
  sha256: string
  notAfter: IsoDate
}

/** The values of a daemon configuration (docs/nodes.md §6.12); secrets are never part of it. */
export interface DaemonConfigValues {
  url: string
  builtIn: boolean
  maxWorkers: number
  dind: DindMode
  egressDeny: string[]
  allowUnisolatedNetworks: boolean
  allowInsecureTransport: boolean
  caCertificates: CaCertificate[]
  pidsLimit: number
  shmSizeBytes: number
  nofile: number
  workerLogMaxSizeBytes: number
  workerLogMaxFiles: number
  imageRetentionMs: number
  pullTimeoutMs: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logFormat: 'json' | 'text'
  /** `all`, `none` or the override keys this daemon accepts (SCANTOR_NODE_OVERRIDES). */
  overrides: 'all' | 'none' | string[]
  dns: DaemonDnsConfig
}

/** Mirrors the structure of DaemonConfigValues with a leaf type T (sources, rejected messages, overrides). */
export type DaemonConfigTree<T> = { [K in keyof DaemonConfigValues]?: DaemonConfigValues[K] extends DaemonDnsConfig ? { [D in keyof DaemonDnsConfig]?: T } : T }

/** The overrides an admin set (only overridden keys; `dns` nested). */
export interface DaemonOverrideValues {
  maxWorkers?: number
  pidsLimit?: number
  shmSizeBytes?: number
  nofile?: number
  workerLogMaxSizeBytes?: number
  workerLogMaxFiles?: number
  imageRetentionMs?: number
  pullTimeoutMs?: number
  logLevel?: DaemonConfigValues['logLevel']
  dns?: Partial<Pick<DaemonDnsConfig, 'mode' | 'upstreams' | 'rootServers' | 'localDomains' | 'cacheSizeBytes' | 'maxLookups' | 'upstreamQps' | 'authoritativeQps'>>
}

/** `Node.daemonConfig`: the daemon's report plus the daemon overrides of its instance. */
export interface NodeDaemonConfig {
  values: DaemonConfigValues
  sources: DaemonConfigTree<DaemonConfigSource>
  warnings: string[]
  overrides: DaemonOverrideValues
  overridesRev: number
  appliedOverridesRev: number
  pending: boolean
  rejected: DaemonConfigTree<string>
  overriddenBy: string | null
  overriddenAt: IsoDate | null
  reportedAt: IsoDate
}

export interface NodeInstance {
  version: string
  startedAt: IsoDate
  lastSeenAt: IsoDate
}

export interface Node {
  id: string
  name: string
  builtIn: boolean
  state: NodeState
  endpointProfile: EndpointProfile
  tokenPrefix: string | null
  tokenRotatedAt: IsoDate | null
  pool: string
  labels: Record<string, string>
  maxWorkers: number | null
  cordoned: boolean
  instance: NodeInstance | null
  info: NodeInfo | null
  assignmentsRev: number
  lastSeenAt: IsoDate | null
  createdBy: string | null
  activeWorkers: number
  /**
   * Present on getNode, on the daemon overrides routes and on listNodes with `include=daemonConfig`; null when no
   * daemon of the current instance reported its configuration.
   */
  daemonConfig?: NodeDaemonConfig | null
  createdAt: IsoDate
  updatedAt: IsoDate
}

export type ScantorNode = Node

/** Join instructions for a remote node; the token is inlined or `${SCANTOR_NODE_TOKEN}`. */
export interface NodeJoin {
  dockerRun: string
  compose: string
  env: { SCANTOR_URL: string; SCANTOR_NODE_TOKEN: string }
}

/** `createNode` / `rotateNodeToken` response: the token is shown once. */
export interface NodeWithToken {
  node: Node
  token: string
  join: NodeJoin
}
