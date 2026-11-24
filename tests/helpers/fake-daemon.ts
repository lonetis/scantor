import { readFileSync } from 'node:fs'
import { BlockList, isIPv6 } from 'node:net'
import { join } from 'node:path'
import type { DaemonConfigSource, DaemonConfigTree, DaemonConfigValues, DaemonDnsConfig, NodeResolverReport } from '#shared/types/nodes'
import { env } from './env'

// What a fake node daemon reports besides its capacity (docs/nodes.md §6.11, §6.12; docs/api.md §7.1, §7.3): the
// state of its node resolver (`info.resolver`) and its daemon configuration (`daemonConfig`), and how it applies the
// daemon overrides of an assignments response, as the real daemon does: the environment with the override values
// applied, no comparison of revisions, keys this daemon does not know or may not change and servers inside its
// SCANTOR_NODE_EGRESS_DENY rejected with a message. Its report keeps the daemon's caps (DAEMON_REPORT_CAPS), so it is
// a report a real daemon could send. The fake nodes of helpers/api-platform-nodes.ts and helpers/e2e-runtime-nodes.ts
// report these when a test asks for it; otherwise they behave like a daemon older than both features.

/** One overridable key of schemas/daemon-overrides.json. */
export interface DaemonOverrideKey {
  type: 'integer' | 'string' | 'array'
  min?: number
  max?: number
  enum?: string[]
  minItems?: number
  maxItems?: number
  format?: string
  /** the environment variable the key overrides */
  env: string
}

let overrideKeys: Record<string, DaemonOverrideKey> | undefined

/** The overridable keys (dotted, for example `dns.mode`) and their bounds: schemas/daemon-overrides.json. */
export function daemonOverrideKeys(): Record<string, DaemonOverrideKey> {
  overrideKeys ??= (JSON.parse(readFileSync(join(env.paths.repo, 'schemas', 'daemon-overrides.json'), 'utf8')) as { keys: Record<string, DaemonOverrideKey> })
    .keys
  return overrideKeys
}

/** The daemon configuration a daemon reports in hello and status (`daemonConfig` of docs/api.md §7.1). */
export interface DaemonConfigReport {
  appliedOverridesRev: number
  values: DaemonConfigValues
  sources: DaemonConfigTree<DaemonConfigSource>
  warnings: string[]
  rejected: DaemonConfigTree<string>
}

/** The daemon overrides of an assignments response (docs/api.md §7.2). */
export interface AssignedOverrides {
  rev: number
  values: Record<string, unknown>
}

export interface FakeDaemonConfigOptions {
  /** values that differ from the defaults below (`dns` merged) */
  values?: Partial<Omit<DaemonConfigValues, 'dns'>> & { dns?: Partial<DaemonDnsConfig> }
  /** dotted keys whose value the daemon took from its environment; every other value counts as a default */
  fromEnv?: string[]
  /** configuration warnings (the report keeps at most 32, of at most 512 characters each) */
  warnings?: string[]
}

const MIB = 1024 * 1024

/**
 * The caps of the daemon's configuration report (internal/node settings.go boundReport, docs/nodes.md §6.12): at most
 * 32 certificates of SCANTOR_CA_CERT (subjects of at most 256 characters), 256 CIDRs of SCANTOR_NODE_EGRESS_DENY and
 * 32 warnings, texts (warnings, rejected messages) of at most 512 characters, and a JSON of at most 64 KiB.
 */
export const DAEMON_REPORT_CAPS = { bytes: 65_536, caCertificates: 32, egressDeny: 256, warnings: 32, textChars: 512, subjectChars: 256 } as const

/** The rejection of a dns.upstreams or dns.rootServers override that names a server only the environment may name. */
export const ENVIRONMENT_ONLY_SERVER = 'private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)'

/** Cuts a text to at most `max` characters (code points), ending with "…" when it cut, like the daemon. */
export function truncateChars(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/** The configuration of a remote node daemon whose environment sets only its URL and token. */
function defaultValues(): DaemonConfigValues {
  return {
    url: env.publicUrl,
    builtIn: false,
    maxWorkers: 8,
    dind: 'disabled',
    egressDeny: ['169.254.0.0/16', 'fd00:ec2::254/128', '100.100.100.200/32'],
    allowUnisolatedNetworks: false,
    allowInsecureTransport: false,
    caCertificates: [],
    pidsLimit: 4096,
    shmSizeBytes: 256 * MIB,
    nofile: 65536,
    workerLogMaxSizeBytes: 20 * MIB,
    workerLogMaxFiles: 3,
    imageRetentionMs: 24 * 3_600_000,
    pullTimeoutMs: 30 * 60_000,
    logLevel: 'info',
    logFormat: 'json',
    overrides: 'all',
    dns: {
      mode: 'recursive',
      upstreams: ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '2606:4700:4700::1111', '2606:4700:4700::1001', '2001:4860:4860::8888', '2001:4860:4860::8844'],
      rootServers: [],
      localDomains: [],
      cacheSizeBytes: 256 * MIB,
      maxLookups: 1000,
      upstreamQps: 0,
      authoritativeQps: 200,
    },
  }
}

/** The dotted keys of a configuration tree (`dns` is the only nested object). */
function leafKeys(values: object): string[] {
  return Object.entries(values).flatMap(([key, value]) =>
    key === 'dns' && value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).map((inner) => `dns.${inner}`) : [key],
  )
}

/** A tree mirroring the configuration's structure from dotted keys. */
function treeOf<T>(entries: Iterable<[string, T]>): DaemonConfigTree<T> {
  const tree: Record<string, unknown> = {}
  for (const [key, value] of entries) {
    const [head, inner] = key.split('.', 2) as [string, string | undefined]
    if (inner === undefined) tree[head] = value
    else tree[head] = { ...((tree[head] as Record<string, unknown> | undefined) ?? {}), [inner]: value }
  }
  return tree as DaemonConfigTree<T>
}

/** The dotted entries of an override document: `{maxWorkers: 4, dns: {mode: 'iterative'}}` → maxWorkers, dns.mode. */
function flatten(values: Record<string, unknown>): [string, unknown][] {
  return Object.entries(values).flatMap(([key, value]): [string, unknown][] =>
    key === 'dns' && value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value as Record<string, unknown>).map(([inner, v]): [string, unknown] => [`dns.${inner}`, v])
      : [[key, value]],
  )
}

/**
 * The daemon configuration of a fake daemon: its environment, the overrides it applied from the last assignments
 * response and the keys it rejected. `report()` is the `daemonConfig` of its hello and status reports.
 */
export class FakeDaemonConfig {
  readonly env: DaemonConfigValues
  readonly warnings: string[]
  private readonly fromEnv: Set<string>
  private applied = new Map<string, unknown>()
  private refused = new Map<string, string>()
  appliedRev = 0

  constructor(options: FakeDaemonConfigOptions = {}) {
    const defaults = defaultValues()
    const { dns, ...values } = options.values ?? {}
    this.env = { ...defaults, ...values, dns: { ...defaults.dns, ...dns } }
    this.fromEnv = new Set(['url', ...(options.fromEnv ?? [])])
    this.warnings = options.warnings ?? []
  }

  /** The values in effect: the environment with the applied overrides. */
  get values(): DaemonConfigValues {
    const values = structuredClone(this.env) as unknown as Record<string, unknown> & { dns: Record<string, unknown> }
    for (const [key, value] of this.applied) {
      if (key.startsWith('dns.')) values.dns[key.slice(4)] = value
      else values[key] = value
    }
    return values as unknown as DaemonConfigValues
  }

  /**
   * Applies the daemon overrides of an assignments response like the daemon: always the environment plus the values
   * (whatever the revision), keys outside schemas/daemon-overrides.json rejected as unknown to this daemon version,
   * keys outside its SCANTOR_NODE_OVERRIDES allow-list as not allowed, and server lists with a server inside its
   * SCANTOR_NODE_EGRESS_DENY as environment-only (the API already refuses the private and special-purpose ranges).
   * Returns whether the values in effect changed.
   */
  apply(overrides: AssignedOverrides | undefined): boolean {
    if (!overrides) return false
    const known = daemonOverrideKeys()
    const allowed = this.env.overrides
    const applied = new Map<string, unknown>()
    const refused = new Map<string, string>()
    for (const [key, value] of flatten(overrides.values)) {
      if (!(key in known)) refused.set(key, 'not supported by this daemon version')
      else if (allowed === 'none' || (Array.isArray(allowed) && !allowed.includes(key))) refused.set(key, 'not allowed on this node')
      else if ((key === 'dns.upstreams' || key === 'dns.rootServers') && this.namesDeniedServer(value)) refused.set(key, ENVIRONMENT_ONLY_SERVER)
      else applied.set(key, value)
    }
    const before = JSON.stringify(this.values)
    this.applied = applied
    this.refused = refused
    this.appliedRev = overrides.rev
    return JSON.stringify(this.values) !== before
  }

  /** Whether a server list names a server inside the environment's egress deny list (`host` never does). */
  private namesDeniedServer(servers: unknown): boolean {
    const deny = new BlockList()
    for (const cidr of this.env.egressDeny) {
      const [address, bits] = cidr.split('/') as [string, string]
      deny.addSubnet(address, Number(bits), isIPv6(address) ? 'ipv6' : 'ipv4')
    }
    return (Array.isArray(servers) ? servers : []).some((server) => {
      if (typeof server !== 'string' || server === 'host') return false
      // ip, ip:port, [v6]:port or v6 (docs/api.md §4.17)
      const bracketed = /^\[(.+)\]:\d+$/.exec(server)
      const address = bracketed ? bracketed[1]! : /^[\d.]+:\d+$/.test(server) ? server.slice(0, server.lastIndexOf(':')) : server
      return deny.check(address, isIPv6(address) ? 'ipv6' : 'ipv4')
    })
  }

  /** A restarted daemon process starts from its environment again. */
  reset(): void {
    this.applied = new Map()
    this.refused = new Map()
    this.appliedRev = 0
  }

  /** The `daemonConfig` of hello and status, within the daemon's caps (boundReport). */
  report(): DaemonConfigReport {
    const values = this.values
    const sources = leafKeys(values).map((key): [string, DaemonConfigSource] => [
      key,
      this.applied.has(key) ? 'override' : this.fromEnv.has(key) ? 'env' : 'default',
    ])
    return boundReport({
      appliedOverridesRev: this.appliedRev,
      values,
      sources: treeOf(sources),
      warnings: [...this.warnings],
      rejected: treeOf([...this.refused].map(([key, message]): [string, string] => [key, truncateChars(message, DAEMON_REPORT_CAPS.textChars)])),
    })
  }
}

/**
 * Cuts a report to the daemon's caps like internal/node boundReport: certificate subjects and warnings to their length,
 * the certificates, the deny list and the warnings to their counts, then, while the JSON exceeds 64 KiB, entries from
 * the end of the certificates, the warnings and the deny list. When it cut a list, the last warning says what (one of
 * the 32 warnings).
 */
function boundReport(report: DaemonConfigReport): DaemonConfigReport {
  const caps = DAEMON_REPORT_CAPS
  const certificates = report.values.caCertificates.map((certificate) => ({ ...certificate, subject: truncateChars(certificate.subject, caps.subjectChars) }))
  const deny = report.values.egressDeny
  const warnings = report.warnings.map((warning) => truncateChars(warning, caps.textChars))
  let keepCertificates = Math.min(certificates.length, caps.caCertificates)
  let keepDeny = Math.min(deny.length, caps.egressDeny)
  let keepWarnings = Math.min(warnings.length, caps.warnings)
  for (;;) {
    const cut = keepCertificates < certificates.length || keepDeny < deny.length || keepWarnings < warnings.length
    if (cut && keepWarnings === caps.warnings) keepWarnings-- // room for the note
    const parts = [
      ...(keepCertificates < certificates.length ? [`${keepCertificates} of ${certificates.length} certificates of SCANTOR_CA_CERT`] : []),
      ...(keepDeny < deny.length ? [`${keepDeny} of ${deny.length} CIDRs of SCANTOR_NODE_EGRESS_DENY`] : []),
      ...(keepWarnings < warnings.length ? [`${keepWarnings} of ${warnings.length} warnings`] : []),
    ]
    const bounded: DaemonConfigReport = {
      ...report,
      values: { ...report.values, caCertificates: certificates.slice(0, keepCertificates), egressDeny: deny.slice(0, keepDeny) },
      warnings: [
        ...warnings.slice(0, keepWarnings),
        ...(cut ? [`the daemon configuration report is truncated: it lists ${parts.join(', ')} (the daemon applies every certificate and CIDR)`] : []),
      ],
    }
    if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= caps.bytes || keepCertificates + keepWarnings + keepDeny === 0) return bounded
    if (keepCertificates > 0) keepCertificates--
    else if (keepWarnings > 0) keepWarnings--
    else keepDeny--
  }
}

/** The statistics of fakeResolverReport (`info.resolver.stats`). */
export const FAKE_RESOLVER_STATS: Readonly<NonNullable<NodeResolverReport['stats']>> = {
  queries: 120_345,
  cacheHits: 98_000,
  lookups: 20_100,
  failures: 340,
  inflight: 12,
  qps: 850.5,
  conntrackUsed: 0.05,
}

/** A node resolver report (`info.resolver`) of a ready resolver at 10.99.0.1, with the given fields replaced. */
export function fakeResolverReport(overrides: Partial<NodeResolverReport> = {}): NodeResolverReport {
  return {
    mode: 'recursive',
    state: 'ready',
    address: '10.99.0.1',
    kept: false,
    error: null,
    since: new Date().toISOString(),
    spec: `sha256:${'5e'.repeat(32)}`,
    ipv6: false,
    upstreamOk: true,
    stats: { ...FAKE_RESOLVER_STATS },
    ...overrides,
  }
}
