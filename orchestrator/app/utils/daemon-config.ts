import { DAEMON_LOG_LEVELS, DAEMON_OVERRIDE_BOUNDS, DAEMON_OVERRIDE_KEYS, RESOLVER_MODES, updateNodeDaemonOverridesBody } from '#shared/schemas/nodes'
import type { DaemonOverrideKey, UpdateNodeDaemonOverridesBody } from '#shared/schemas/nodes'
import type { DaemonConfigSource, DaemonConfigValues, NodeDaemonConfig, ScantorNode } from '#shared/types/nodes'
import { stripEscapes } from './ansi'
import { errorIssues, type ApiError } from './errors'
import { formatBytes, formatCount } from './format'
import type { FieldError } from './json-pointer'

// The daemon configuration of a node and its daemon overrides on the node page (docs/ui.md §5.15, docs/nodes.md §6.12):
// one row per setting with its environment variable and source, and the override form, which sends only the changed
// keys as a JSON merge patch (null removes an override). Values come from the node's daemon, so their text is shown
// without escape sequences.

/** How a value of the daemon configuration is shown. */
type ValueFormat = 'text' | 'flag' | 'count' | 'workers' | 'bytes' | 'duration' | 'list' | 'qps' | 'certificates' | 'overrides'

/** How an overridable value is edited: numbers, byte sizes and durations in the syntax of the variable, a choice, a list. */
export type DaemonOverrideInput = 'count' | 'bytes' | 'duration' | 'select' | 'list'

export interface DaemonConfigField {
  /** Dotted path into the daemon configuration values (the override key for overridable settings). */
  key: string
  label: string
  /** The daemon's environment variable. */
  env: string
  format: ValueFormat
  mono?: boolean
  /** The text of an empty list. */
  empty?: string
  /** Set for the overridable settings. */
  input?: DaemonOverrideInput
  options?: readonly string[]
}

/** Every setting of the daemon configuration in display order (docs/nodes.md §2). */
export const DAEMON_CONFIG_FIELDS: readonly DaemonConfigField[] = [
  { key: 'url', label: 'Orchestrator URL', env: 'SCANTOR_URL', format: 'text', mono: true },
  { key: 'builtIn', label: 'Built-in node', env: 'SCANTOR_NODE_BUILTIN', format: 'flag' },
  { key: 'maxWorkers', label: 'Max workers', env: 'SCANTOR_NODE_MAX_WORKERS', format: 'workers', input: 'count' },
  { key: 'dind', label: 'DinD mode', env: 'SCANTOR_NODE_DIND', format: 'text' },
  { key: 'egressDeny', label: 'Egress deny list', env: 'SCANTOR_NODE_EGRESS_DENY', format: 'list', mono: true, empty: 'none (egress helper off)' },
  { key: 'allowUnisolatedNetworks', label: 'Unisolated networks allowed', env: 'SCANTOR_ALLOW_UNISOLATED_NETWORKS', format: 'flag' },
  { key: 'allowInsecureTransport', label: 'Insecure transport allowed', env: 'SCANTOR_ALLOW_INSECURE_TRANSPORT', format: 'flag' },
  { key: 'caCertificates', label: 'CA certificates', env: 'SCANTOR_CA_CERT', format: 'certificates' },
  { key: 'pidsLimit', label: 'PIDs limit', env: 'SCANTOR_NODE_PIDS_LIMIT', format: 'count', input: 'count' },
  { key: 'shmSizeBytes', label: 'Shared memory', env: 'SCANTOR_NODE_SHM_SIZE', format: 'bytes', input: 'bytes' },
  { key: 'nofile', label: 'Open files limit', env: 'SCANTOR_NODE_NOFILE', format: 'count', input: 'count' },
  { key: 'workerLogMaxSizeBytes', label: 'Worker log file size', env: 'SCANTOR_NODE_WORKER_LOG_MAX_SIZE', format: 'bytes', input: 'bytes' },
  { key: 'workerLogMaxFiles', label: 'Worker log files', env: 'SCANTOR_NODE_WORKER_LOG_MAX_FILES', format: 'count', input: 'count' },
  { key: 'imageRetentionMs', label: 'Image retention', env: 'SCANTOR_NODE_IMAGE_RETENTION', format: 'duration', input: 'duration' },
  { key: 'pullTimeoutMs', label: 'Pull timeout', env: 'SCANTOR_NODE_PULL_TIMEOUT', format: 'duration', input: 'duration' },
  { key: 'logLevel', label: 'Log level', env: 'SCANTOR_LOG_LEVEL', format: 'text', input: 'select', options: DAEMON_LOG_LEVELS },
  { key: 'logFormat', label: 'Log format', env: 'SCANTOR_LOG_FORMAT', format: 'text' },
  { key: 'overrides', label: 'Allowed overrides', env: 'SCANTOR_NODE_OVERRIDES', format: 'overrides', mono: true },
  { key: 'dns.mode', label: 'Resolver mode', env: 'SCANTOR_NODE_DNS_MODE', format: 'text', input: 'select', options: RESOLVER_MODES },
  { key: 'dns.upstreams', label: 'Upstream servers', env: 'SCANTOR_NODE_DNS_UPSTREAMS', format: 'list', mono: true, input: 'list' },
  {
    key: 'dns.rootServers',
    label: 'Root servers',
    env: 'SCANTOR_NODE_DNS_ROOT_SERVERS',
    format: 'list',
    mono: true,
    empty: 'IANA root servers',
    input: 'list',
  },
  { key: 'dns.localDomains', label: 'Local domains', env: 'SCANTOR_NODE_DNS_LOCAL_DOMAINS', format: 'list', mono: true, input: 'list' },
  { key: 'dns.cacheSizeBytes', label: 'Resolver cache', env: 'SCANTOR_NODE_DNS_CACHE_SIZE', format: 'bytes', input: 'bytes' },
  { key: 'dns.maxLookups', label: 'Lookups in flight', env: 'SCANTOR_NODE_DNS_MAX_LOOKUPS', format: 'count', input: 'count' },
  { key: 'dns.upstreamQps', label: 'Queries/s per upstream server', env: 'SCANTOR_NODE_DNS_UPSTREAM_QPS', format: 'qps', input: 'count' },
  { key: 'dns.authoritativeQps', label: 'Queries/s per authoritative server', env: 'SCANTOR_NODE_DNS_AUTHORITATIVE_QPS', format: 'qps', input: 'count' },
]

export interface DaemonOverrideField extends DaemonConfigField {
  key: DaemonOverrideKey
  input: DaemonOverrideInput
}

/** The overridable settings in display order (the keys of updateNodeDaemonOverrides). */
export const DAEMON_OVERRIDE_FIELDS = DAEMON_CONFIG_FIELDS.filter((field): field is DaemonOverrideField => field.input !== undefined)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value at a dotted path of a configuration tree (values, sources, overrides, rejected); own keys only. */
export function configValueAt(tree: unknown, key: string): unknown {
  let current = tree
  for (const part of key.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined
    current = current[part]
  }
  return current
}

// ── formatting ───────────────────────────────────────────────────────────────

const BYTE_SUFFIXES = [
  ['TiB', 1024 ** 4],
  ['GiB', 1024 ** 3],
  ['MiB', 1024 ** 2],
  ['KiB', 1024],
] as const

const DURATION_UNITS = [
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
  ['ms', 1],
] as const

/** A byte count in the syntax of the daemon's byte-size variables: the largest binary suffix that divides it ("256MiB"). */
export function formatByteSizeInput(bytes: number): string {
  for (const [suffix, size] of BYTE_SUFFIXES) {
    if (bytes >= size && bytes % size === 0) return `${bytes / size}${suffix}`
  }
  return String(bytes)
}

const BYTE_SIZE = /^(\d+)\s*(kib|mib|gib|tib)?$/i

/** Parses "512MiB", "1 GiB" or a plain byte count (the daemon's byte-size syntax); null when it is none. */
export function parseByteSizeInput(text: string): number | null {
  const match = BYTE_SIZE.exec(text.trim())
  if (!match) return null
  const unit = match[2] ? BYTE_SUFFIXES.find(([suffix]) => suffix.toLowerCase() === match[2]!.toLowerCase())![1] : 1
  const bytes = Number(match[1]) * unit
  return Number.isSafeInteger(bytes) ? bytes : null
}

/** Milliseconds in the syntax of the daemon's duration variables (Go durations): "24h", "1h30m", "1s500ms". */
export function formatDurationInput(ms: number): string {
  let rest = Math.max(0, Math.round(ms))
  if (rest === 0) return '0s'
  const parts: string[] = []
  for (const [unit, size] of DURATION_UNITS) {
    const count = Math.floor(rest / size)
    if (count === 0) continue
    parts.push(`${count}${unit}`)
    rest -= count * size
  }
  return parts.join('')
}

const DURATION = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h)/g
const DURATION_UNIT_MS: Record<string, number> = Object.fromEntries(DURATION_UNITS)

/** Parses a Go duration such as "500ms", "30s", "15m", "1h30m" or "0" into milliseconds; null when it is none. */
export function parseDurationInput(text: string): number | null {
  const value = text.trim().replace(/\s+/g, '')
  if (value === '0') return 0
  if (!DURATION.test(value)) return null
  let total = 0
  for (const [, amount, unit] of value.matchAll(DURATION_PART)) total += Number(amount) * DURATION_UNIT_MS[unit!]!
  const ms = Math.round(total)
  return Number.isSafeInteger(ms) ? ms : null
}

/** A list in the form text of a list setting: one entry per line. */
export function formatListInput(items: readonly string[]): string {
  return items.join('\n')
}

/** The entries of a list setting's text: separated by lines, commas or spaces. */
export function parseListInput(text: string): string[] {
  return text.split(/[\s,]+/).filter((item) => item !== '')
}

function plainText(value: unknown): string {
  if (typeof value === 'string') return stripEscapes(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return stripEscapes(JSON.stringify(value) ?? '')
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

/** The display text of one value of the daemon configuration. */
export function formatDaemonConfigValue(field: DaemonConfigField, value: unknown): string {
  switch (field.format) {
    case 'flag':
      return typeof value === 'boolean' ? (value ? 'yes' : 'no') : plainText(value)
    case 'count':
      return typeof value === 'number' ? formatCount(value) : plainText(value)
    case 'workers':
      return value === 0 ? 'number of CPUs' : typeof value === 'number' ? formatCount(value) : plainText(value)
    case 'bytes':
      return typeof value === 'number' ? formatBytes(value) : plainText(value)
    case 'duration':
      return typeof value === 'number' ? formatDurationInput(value) : plainText(value)
    case 'qps':
      return value === 0 ? 'no limit' : typeof value === 'number' ? `${formatCount(value)}/s` : plainText(value)
    case 'list': {
      const items = stringList(value)
      if (!items) return plainText(value)
      return items.length === 0 ? (field.empty ?? 'none') : stripEscapes(items.join(', '))
    }
    case 'overrides': {
      if (value === 'all' || value === 'none') return value
      const items = stringList(value)
      return items ? (items.length === 0 ? 'none' : stripEscapes(items.join(', '))) : plainText(value)
    }
    case 'certificates': {
      if (!Array.isArray(value)) return plainText(value)
      if (value.length === 0) return 'none'
      return value
        .map((certificate: unknown) => {
          const subject = isRecord(certificate) ? plainText(certificate.subject ?? '') : plainText(certificate)
          const notAfter = isRecord(certificate) && typeof certificate.notAfter === 'string' ? certificate.notAfter.slice(0, 10) : ''
          return notAfter ? `${subject} (until ${stripEscapes(notAfter)})` : subject
        })
        .join('; ')
    }
    case 'text':
      return plainText(value)
  }
}

/** The exact value behind a rounded display text (the cell's tooltip). */
function exactValue(field: DaemonConfigField, value: unknown): string | undefined {
  if (typeof value !== 'number') return undefined
  if (field.format === 'bytes') return `${formatCount(value)} bytes`
  if (field.format === 'duration') return `${formatCount(value)} ms`
  return undefined
}

// ── rows ─────────────────────────────────────────────────────────────────────

const SOURCES: readonly DaemonConfigSource[] = ['env', 'default', 'override']

export interface DaemonConfigRow {
  key: string
  label: string
  env: string
  value: string
  /** The exact value when the text rounds it. */
  title?: string
  mono: boolean
  source: DaemonConfigSource
  /** A daemon override of this setting that the daemon has not applied yet, or rejected. */
  note: { tone: 'pending' | 'rejected'; text: string } | null
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function rowNote(config: NodeDaemonConfig, field: DaemonConfigField, value: unknown, source: DaemonConfigSource): DaemonConfigRow['note'] {
  const rejected = configValueAt(config.rejected, field.key)
  if (typeof rejected === 'string') return { tone: 'rejected', text: `Override rejected: ${stripEscapes(rejected)}` }
  if (!config.pending) return null
  const desired = configValueAt(config.overrides, field.key)
  if (desired !== undefined && !(source === 'override' && sameValue(desired, value))) {
    return { tone: 'pending', text: `Override ${formatDaemonConfigValue(field, desired)} pending` }
  }
  if (desired === undefined && source === 'override') return { tone: 'pending', text: 'Removal of the override pending' }
  return null
}

/**
 * The rows of the daemon configuration table. A source the daemon left out is a default; a setting the daemon did not
 * report (another daemon version) has no row.
 */
export function daemonConfigRows(config: NodeDaemonConfig): DaemonConfigRow[] {
  return DAEMON_CONFIG_FIELDS.flatMap((field) => {
    const value = configValueAt(config.values, field.key)
    if (value === undefined) return []
    const reported = configValueAt(config.sources, field.key)
    const source: DaemonConfigSource = SOURCES.includes(reported as DaemonConfigSource) ? (reported as DaemonConfigSource) : 'default'
    return [
      {
        key: field.key,
        label: field.label,
        env: field.env,
        value: formatDaemonConfigValue(field, value),
        title: exactValue(field, value),
        mono: field.mono ?? false,
        source,
        note: rowNote(config, field, value, source),
      },
    ]
  })
}

/** Every override the daemon rejected, with the label of its setting (or its key, for a key this UI does not know). */
export function rejectedOverrides(config: NodeDaemonConfig): { key: string; label: string; message: string }[] {
  const entries: { key: string; label: string; message: string }[] = []
  const walk = (tree: unknown, prefix: string): void => {
    if (!isRecord(tree)) return
    for (const [name, value] of Object.entries(tree)) {
      const key = prefix ? `${prefix}.${name}` : name
      if (typeof value === 'string') {
        const label = DAEMON_CONFIG_FIELDS.find((field) => field.key === key)?.label ?? stripEscapes(key)
        entries.push({ key, label, message: stripEscapes(value) })
      } else if (!prefix) walk(value, key)
    }
  }
  walk(config.rejected, '')
  return entries
}

/** The number of daemon overrides set for the node's daemon instance. */
export function daemonOverrideCount(config: NodeDaemonConfig): number {
  return DAEMON_OVERRIDE_KEYS.filter((key) => configValueAt(config.overrides, key) !== undefined).length
}

/** The override keys this daemon accepts (its SCANTOR_NODE_OVERRIDES). */
export function allowedOverrideKeys(values: DaemonConfigValues): Set<DaemonOverrideKey> {
  const allowed = values.overrides
  if (allowed === 'all') return new Set(DAEMON_OVERRIDE_KEYS)
  if (!Array.isArray(allowed)) return new Set()
  return new Set(DAEMON_OVERRIDE_KEYS.filter((key) => allowed.includes(key)))
}

/** Why a node has no daemon configuration to show (an old daemon, a report the orchestrator stored as null, or none yet). */
export const DAEMON_CONFIG_MISSING_TEXT = 'The node has not reported a valid daemon configuration (an old daemon or an invalid report)'

/** Why the daemon overrides of a node cannot be edited now (the tooltip of the disabled "Edit overrides"), or null. */
export function editOverridesBlocker(node: ScantorNode): string | null {
  if (node.state === 'revoked') return "The node's token is revoked"
  if (!node.instance) return 'No daemon instance holds the lease of this node'
  if (!node.daemonConfig) return DAEMON_CONFIG_MISSING_TEXT
  if (allowedOverrideKeys(node.daemonConfig.values).size === 0) return "The node's daemon accepts no overrides (SCANTOR_NODE_OVERRIDES)"
  return null
}

/**
 * Why the daemon overrides of a node cannot be reset now (the tooltip of the disabled "Reset overrides"), or null. The
 * reset needs a running daemon instance but no daemon configuration: without one the overrides are not visible, and
 * the reset (idempotent) still removes any that are set.
 */
export function resetOverridesBlocker(node: ScantorNode): string | null {
  if (node.state === 'revoked') return "The node's token is revoked"
  if (!node.instance) return 'No daemon instance holds the lease of this node'
  if (node.daemonConfig && daemonOverrideCount(node.daemonConfig) === 0) return 'No daemon overrides are set'
  return null
}

// ── override form ────────────────────────────────────────────────────────────

/** The override form: numbers for counts, the text of the daemon's variable syntax for everything else. */
export type DaemonOverrideForm = Record<DaemonOverrideKey, number | string | null>

function initialInput(field: DaemonOverrideField, value: unknown): number | string | null {
  switch (field.input) {
    case 'count':
      return typeof value === 'number' ? value : null
    case 'bytes':
      return typeof value === 'number' ? formatByteSizeInput(value) : ''
    case 'duration':
      return typeof value === 'number' ? formatDurationInput(value) : ''
    case 'select':
      return typeof value === 'string' ? value : null
    case 'list':
      return formatListInput(stringList(value) ?? [])
  }
}

/**
 * The override form of a daemon configuration: every overridable setting with its override, or else its value. A
 * max workers value of 0 (the number of CPUs) starts at the reported max workers, since an override is at least 1.
 */
export function daemonOverrideForm(config: NodeDaemonConfig, reportedMaxWorkers: number | null): DaemonOverrideForm {
  const form = {} as DaemonOverrideForm
  for (const field of DAEMON_OVERRIDE_FIELDS) {
    const desired = configValueAt(config.overrides, field.key)
    let value = desired ?? configValueAt(config.values, field.key)
    if (field.key === 'maxWorkers' && value === 0) value = reportedMaxWorkers ?? null
    form[field.key] = initialInput(field, value)
  }
  return form
}

export interface DaemonOverridesDraft {
  /** The merge patch of the changed keys; empty when nothing changed. */
  patch: UpdateNodeDaemonOverridesBody
  errors: FieldError[]
}

/** The error of an input that is empty or does not parse (a list always parses). */
const UNPARSABLE: Record<DaemonOverrideInput, string> = {
  count: 'Enter a value',
  select: 'Choose a value',
  bytes: 'Use a byte count with an optional KiB, MiB, GiB or TiB suffix, such as 512MiB',
  duration: 'Use a duration such as 500ms, 30s, 15m or 24h',
  list: 'Enter a list',
}

/** The parsed value of a form input, or null when it is empty or does not parse. */
function parseInput(field: DaemonOverrideField, input: number | string | null | undefined): unknown {
  switch (field.input) {
    case 'count':
      return typeof input === 'number' && Number.isFinite(input) ? input : null
    case 'bytes':
      return parseByteSizeInput(String(input ?? ''))
    case 'duration':
      return parseDurationInput(String(input ?? ''))
    case 'select':
      return input ?? null
    case 'list':
      return parseListInput(String(input ?? ''))
  }
}

function sameInput(a: number | string | null | undefined, b: number | string | null | undefined): boolean {
  const normal = (value: number | string | null | undefined) => (typeof value === 'string' ? value.trim() : (value ?? null))
  return normal(a) === normal(b)
}

function setPatch(patch: Record<string, unknown>, key: DaemonOverrideKey, value: unknown): void {
  const [head, member] = key.split('.') as [string, string | undefined]
  if (member === undefined) {
    patch[head] = value
    return
  }
  const nested = (patch[head] ??= {}) as Record<string, unknown>
  nested[member] = value
}

function boundsText(field: DaemonOverrideField): string | null {
  const bounds = (DAEMON_OVERRIDE_BOUNDS as Record<string, { min: number; max: number }>)[field.key]
  if (!bounds) return null
  const show = (value: number) => (field.input === 'bytes' ? formatBytes(value) : field.input === 'duration' ? formatDurationInput(value) : formatCount(value))
  return `Must be between ${show(bounds.min)} and ${show(bounds.max)}`
}

interface ZodIssueLike {
  code: string
  path: PropertyKey[]
  message: string
  origin?: string
  expected?: string
  minimum?: number | bigint
  maximum?: number | bigint
}

function issueMessage(field: DaemonOverrideField, issue: ZodIssueLike, list: readonly string[]): string {
  if (issue.path.length > field.key.split('.').length) {
    const index = issue.path.at(-1)
    const item = typeof index === 'number' ? list[index] : undefined
    return item === undefined ? issue.message : `${item}: ${issue.message}`
  }
  if (issue.origin === 'array' && issue.code === 'too_small')
    return `Enter at least ${Number(issue.minimum)} ${Number(issue.minimum) === 1 ? 'entry' : 'entries'}`
  if (issue.origin === 'array' && issue.code === 'too_big') return `Enter at most ${Number(issue.maximum)} entries`
  if (issue.code === 'too_small' || issue.code === 'too_big') return boundsText(field) ?? issue.message
  if (issue.code === 'invalid_type' && issue.expected === 'int') return 'Must be a whole number'
  return issue.message
}

/**
 * The merge patch of an override form against the form it started as: a changed setting sends its value, a removed
 * override sends null, and an unchanged one is left out. Inputs that do not parse and values the API would reject
 * (updateNodeDaemonOverridesBody) become field errors named by the override key.
 */
export function daemonOverridesPatch(initial: DaemonOverrideForm, form: DaemonOverrideForm, removed: ReadonlySet<DaemonOverrideKey>): DaemonOverridesDraft {
  const patch: Record<string, unknown> = {}
  const errors: FieldError[] = []
  for (const field of DAEMON_OVERRIDE_FIELDS) {
    if (removed.has(field.key)) {
      setPatch(patch, field.key, null)
      continue
    }
    const input = form[field.key]
    if (sameInput(input, initial[field.key])) continue
    const value = parseInput(field, input)
    if (value === null) {
      errors.push({ name: field.key, message: UNPARSABLE[field.input] })
      continue
    }
    if (!sameValue(value, parseInput(field, initial[field.key]))) setPatch(patch, field.key, value)
  }
  if (errors.length === 0 && Object.keys(patch).length > 0) {
    const result = updateNodeDaemonOverridesBody.safeParse(patch)
    if (!result.success) {
      for (const issue of result.error.issues as ZodIssueLike[]) {
        const path = issue.path.map(String)
        const field = DAEMON_OVERRIDE_FIELDS.find((candidate) => candidate.key === path.slice(0, candidate.key.split('.').length).join('.'))
        if (!field) {
          errors.push({ name: '', message: issue.message })
          continue
        }
        if (errors.some((error) => error.name === field.key)) continue
        errors.push({ name: field.key, message: issueMessage(field, issue, stringList(configValueAt(patch, field.key)) ?? []) })
      }
    }
  }
  return { patch: patch as UpdateNodeDaemonOverridesBody, errors }
}

/** The inline text of a failed updateNodeDaemonOverrides or deleteNodeDaemonOverrides. */
export function daemonOverridesErrorText(error: ApiError): string {
  if (error.code === 'daemonOverridesUnavailable') {
    const reason = error.details.reason
    if (reason === 'noInstance') return 'No daemon instance holds the lease of this node; daemon overrides need a running daemon.'
    if (reason === 'notReported') return `${DAEMON_CONFIG_MISSING_TEXT}. A daemon that is still connecting reports it shortly.`
    if (reason === 'notAllowed') {
      const keys = Array.isArray(error.details.keys) ? error.details.keys.filter((key): key is string => typeof key === 'string') : []
      const labels = keys.map((key) => DAEMON_CONFIG_FIELDS.find((field) => field.key === key)?.label ?? stripEscapes(key))
      return labels.length > 0
        ? `The node's daemon does not accept overrides of ${labels.join(', ')} (SCANTOR_NODE_OVERRIDES).`
        : "The node's daemon does not accept these overrides (SCANTOR_NODE_OVERRIDES)."
    }
    return error.message
  }
  if (error.code === 'validationFailed') {
    const issues = errorIssues(error).map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message))
    return issues.length > 0 ? `${error.message} ${issues.join('; ')}` : error.message
  }
  return error.message
}
