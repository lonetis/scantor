import { isIP } from 'node:net'
import { z } from 'zod'
import { ORCHESTRATOR_COMPONENTS, type OrchestratorComponent } from '#shared/utils/enums'
import { parseBoolean, parseByteSize, parseDuration, parseInteger, parseList } from './env-values'
import { evaluateStartupGuard, type StartupGuardResult } from './startup-guard'

// The orchestrator's only reader of process.env (docs/architecture.md §10). Every variable comes from
// .env.example, where it is documented with its default; the defaults below mirror that file. Invalid values of
// security-relevant variables abort startup (security.md CFG-7); other invalid values log a warning and fall back
// to the default.

export type Env = Record<string, string | undefined>

export interface ConfigIssue {
  variable: string
  message: string
}

export class ConfigError extends Error {
  constructor(readonly issues: ConfigIssue[]) {
    super(`invalid configuration: ${issues.map((issue) => `${issue.variable}: ${issue.message}`).join('; ')}`)
    this.name = 'ConfigError'
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFormat = 'json' | 'text'
export type WorkerCapability = 'NET_BIND_SERVICE' | 'NET_RAW'

export interface Config {
  // core URLs (origins without trailing slash)
  publicUrl: string
  editorUrl: string
  internalUrl: string
  // secrets
  secret: string
  allowInsecureDefaults: boolean
  // first admin
  adminEmail: string | null
  adminPassword: string | null
  // network
  bindAddress: string
  adminBindAddress: string
  registryPort: number
  // endpoints
  mongoUrl: string
  rabbitmqManagementUrl: string
  amqpInternalUrl: string
  amqpPublicUrl: string
  s3InternalUrl: string
  s3PublicUrl: string
  registryPublicHost: string
  // infrastructure credentials
  mongoUser: string
  mongoPassword: string
  mongoDb: string
  mongoAnalyticsUser: string
  mongoAnalyticsPassword: string
  rabbitmqUser: string
  rabbitmqPassword: string
  s3AccessKey: string
  s3SecretKey: string
  s3Bucket: string
  // traefik
  composeProfiles: string[]
  domain: string | null
  trustProxy: boolean
  exposeMongo: boolean
  // orchestrator
  imagePrefix: string
  imageTag: string
  components: OrchestratorComponent[]
  logLevel: LogLevel
  logFormat: LogFormat
  passkeyRpId: string | null
  nodeStatusIntervalMs: number
  nodeAssignmentsWaitMs: number
  nodeOfflineAfterMs: number
  nodeMinFreeDiskBytes: number
  placementMaxConcurrentPulls: number
  workerDrainGraceMs: number
  workerCapAdd: WorkerCapability[]
  tombstoneDays: number
  eventsTtlDays: number
  exportRetentionDays: number
  registryGcIntervalMs: number
  // API limits
  maxRequestBytes: number
  maxUploadBytes: number
  maxScanConfigBytes: number
  maxConcurrentWaits: number
  queryMaxTimeMs: number
  queryMaxDocs: number
  userMaxConcurrentQueries: number
  exportInlineMax: number
  // scans, results and files
  maxAnalysesPerScan: number
  maxWorkersPerScan: number
  maxProcessesPerWorker: number
  userMaxWorkers: number
  authRateLimitScale: number
  maxAnalysisConfigBytes: number
  maxResultBytes: number
  maxFileBytes: number
  maxFilesPerAnalysis: number
  userStorageQuotaBytes: number
  uploadTimeoutMs: number
  workerMinFreeTmpBytes: number
  // builds and task pipeline
  buildTimeoutMs: number
  buildConcurrency: number
  maxImageBytes: number
  buildCacheMaxBytes: number
  describeTimeoutMs: number
  taskMaxPackBytes: number
  taskMaxFiles: number
  taskMaxBytes: number
  // test runs
  testRunTimeoutMs: number
  testRunConcurrency: number
  testRunRetentionDays: number
  draftImageRetentionMs: number
  // scans and queue
  deliveryLimit: number
  scanQueueMaxReady: number
  scanConfirmThreshold: number
  schedulerMaxRestarts: number
  scanStallAfterMs: number
  // ingestor
  ingestPrefetch: number
  ingestBatchSize: number
  ingestFlushIntervalMs: number
  ingestBatchMaxBytes: number
  breakerMinAttempts: number
  breakerRatio: number
  breakerWindowMs: number
  // transport
  /** extra trusted CAs, passed to git workspace helpers */
  caCert: string | null
  /** plaintext public endpoints are allowed: boot step 625 does not warn about them */
  allowInsecureTransport: boolean
  // editor
  editorIdleTimeoutMs: number
  editorMaxRunning: number
  editorStartTimeoutMs: number
  editorApiKeyTtlMs: number
  editorMemoryLimitBytes: number
  editorCpus: number
  editorPidsLimit: number
  editorTmpfsSizeBytes: number
  // workspace helpers
  workspaceMaxBytes: number
  helperConcurrency: number
  helperMemoryLimitBytes: number
  helperPidsLimit: number
  helperTimeoutMs: number
  // git
  gitAllowPrivate: boolean
  // MCP
  mcpEnabled: boolean
  mcpAllowedRedirectOrigins: string[]
  // data sources
  trancoUrl: string
  cruxUrl: string
}

// ── value schemas ─────────────────────────────────────────────────────────────

type Parser<T> = z.ZodType<T, string>

function fromParser<T>(parse: (value: string) => T): Parser<T> {
  return z.string().transform((value, ctx) => {
    try {
      return parse(value)
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message })
      return z.NEVER
    }
  })
}

const duration = (min = 0) =>
  fromParser(parseDuration).pipe(z.number().min(min, `must be at least ${min}ms`)).transform(Math.round)
const byteSize = (min = 0) => fromParser(parseByteSize).pipe(z.number().min(min))
const boolean = () => fromParser(parseBoolean)
const integer = (min: number, max = Number.MAX_SAFE_INTEGER) => fromParser(parseInteger).pipe(z.number().int().min(min).max(max))
const decimal = (min: number, max: number) =>
  z.string().regex(/^\d+(\.\d+)?$/, 'must be a decimal number').transform(Number).pipe(z.number().min(min).max(max))
const nonEmpty = () => z.string().trim().min(1, 'must not be empty')
const oneOf = <T extends string>(values: readonly [T, ...T[]]) => z.string().trim().pipe(z.enum(values))

function parseUrl(value: string, protocols: string[]): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`"${value}" is not a valid URL`)
  }
  if (!protocols.includes(url.protocol)) throw new Error(`must use ${protocols.join(' or ')}`)
  if (url.username || url.password) throw new Error('must not contain credentials')
  return url
}

/** An origin-only URL (no path other than `/`, no query, no fragment), returned without a trailing slash. */
const originUrl = (protocols = ['http:', 'https:']) =>
  fromParser((value) => {
    const url = parseUrl(value, protocols)
    if (url.pathname !== '/' && url.pathname !== '') throw new Error('must not contain a path')
    if (url.search || url.hash) throw new Error('must not contain a query or fragment')
    return url.origin
  })

/** A base URL that may carry a path (data sources, management API); returned without a trailing slash. */
const baseUrl = (protocols = ['http:', 'https:']) =>
  fromParser((value) => {
    const url = parseUrl(value, protocols)
    if (url.search || url.hash) throw new Error('must not contain a query or fragment')
    return url.toString().replace(/\/+$/, '')
  })

const mongoUrl = () =>
  fromParser((value) => {
    const url = parseUrl(value, ['mongodb:', 'mongodb+srv:'])
    return url.toString()
  })

const amqpUrl = () =>
  fromParser((value) => {
    const url = parseUrl(value, ['amqp:', 'amqps:'])
    if (url.pathname !== '/' && url.pathname !== '') throw new Error('must not contain a vhost')
    return `${url.protocol}//${url.host}`
  })

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

const hostname = () =>
  z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(z.string().regex(HOSTNAME, 'must be a DNS host name'))

const hostWithPort = () =>
  fromParser((value) => {
    const input = value.trim()
    let url: URL
    try {
      url = new URL(`http://${input}`)
    } catch {
      throw new Error(`"${value}" is not a host[:port]`)
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.host !== input.toLowerCase()) {
      throw new Error('must be host[:port] without scheme or path')
    }
    return url.host
  })

const ipAddress = () =>
  z
    .string()
    .trim()
    .refine((value) => isIP(value) !== 0, 'must be an IP address')

const imagePrefix = () =>
  z
    .string()
    .trim()
    .refine((value) => value === '' || (value.endsWith('/') && !/\s/.test(value)), 'must be empty or end with "/"')

const imageTag = () => z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, 'must be a Docker image tag')

const components = () =>
  fromParser(parseList).pipe(
    z.array(z.enum(ORCHESTRATOR_COMPONENTS)).min(1, 'must name at least one component').transform((list) => [...new Set(list)]),
  )

const capabilities = () =>
  fromParser(parseList).pipe(z.array(z.enum(['NET_BIND_SERVICE', 'NET_RAW'])).transform((list) => [...new Set(list)]))

const httpsOrigins = () =>
  fromParser((value) =>
    parseList(value).map((entry) => {
      const url = parseUrl(entry, ['https:'])
      if (url.pathname !== '/' || url.search || url.hash) throw new Error(`"${entry}" must be an https origin without path`)
      return url.origin
    }),
  )

const optionalEmail = () =>
  z
    .string()
    .trim()
    .transform((value) => value.toLowerCase())
    .pipe(z.union([z.literal(''), z.email()]))
    .transform((value) => value || null)

const optionalString = () =>
  z
    .string()
    .transform((value) => value || null)

const pem = () =>
  z
    .string()
    .transform((value) => value.replaceAll('\\n', '\n').trim())
    .refine((value) => value === '' || value.includes('-----BEGIN CERTIFICATE-----'), 'must be PEM certificates')
    .transform((value) => value || null)

// ── variable table ──────────────────────────────────────────────────────────

interface VariableSpec<T> {
  /** The environment variable name. */
  name: string
  /** The .env.example default, applied when the variable is unset. */
  fallback: string
  schema: Parser<T>
  /** Invalid values abort startup instead of falling back to the default. */
  security?: boolean
}

const v = <T>(name: string, fallback: string, schema: Parser<T>, security = false): VariableSpec<T> => ({
  name,
  fallback,
  schema,
  security,
})

const VARIABLES = {
  publicUrl: v('SCANTOR_PUBLIC_URL', 'http://localhost:3000', originUrl(), true),
  editorUrl: v('SCANTOR_EDITOR_URL', 'http://localhost:3001', originUrl(), true),
  internalUrl: v('SCANTOR_INTERNAL_URL', 'http://orchestrator:3000', originUrl(), true),

  secret: v('SCANTOR_SECRET', 'scantor-secret-insecure-dev', nonEmpty(), true),
  allowInsecureDefaults: v('SCANTOR_ALLOW_INSECURE_DEFAULTS', 'false', boolean(), true),

  adminEmail: v('SCANTOR_ADMIN_EMAIL', '', optionalEmail(), true),
  adminPassword: v('SCANTOR_ADMIN_PASSWORD', '', optionalString(), true),

  bindAddress: v('SCANTOR_BIND_ADDRESS', '127.0.0.1', ipAddress(), true),
  adminBindAddress: v('SCANTOR_ADMIN_BIND_ADDRESS', '127.0.0.1', ipAddress(), true),
  registryPort: v('SCANTOR_REGISTRY_PORT', '5000', integer(1, 65_535), true),

  mongoUrl: v('SCANTOR_MONGO_URL', 'mongodb://mongo:27017/?replicaSet=rs0&authSource=admin', mongoUrl(), true),
  rabbitmqManagementUrl: v('SCANTOR_RABBITMQ_MANAGEMENT_URL', 'http://rabbitmq:15672', baseUrl(), true),
  amqpInternalUrl: v('SCANTOR_AMQP_INTERNAL_URL', 'amqp://rabbitmq:5672', amqpUrl(), true),
  amqpPublicUrl: v('SCANTOR_AMQP_PUBLIC_URL', 'amqp://localhost:5672', amqpUrl(), true),
  s3InternalUrl: v('SCANTOR_S3_INTERNAL_URL', 'http://rustfs:9000', originUrl(), true),
  s3PublicUrl: v('SCANTOR_S3_PUBLIC_URL', 'http://localhost:9000', originUrl(), true),
  registryPublicHost: v('SCANTOR_REGISTRY_PUBLIC_HOST', 'localhost:5000', hostWithPort(), true),

  mongoUser: v('SCANTOR_MONGO_USER', 'scantor', nonEmpty(), true),
  mongoPassword: v('SCANTOR_MONGO_PASSWORD', 'mongo-insecure-dev', nonEmpty(), true),
  mongoDb: v('SCANTOR_MONGO_DB', 'scantor', z.string().regex(/^[A-Za-z0-9_-]{1,63}$/, 'must be a database name'), true),
  mongoAnalyticsUser: v('SCANTOR_MONGO_ANALYTICS_USER', 'scantor_analytics', nonEmpty(), true),
  mongoAnalyticsPassword: v('SCANTOR_MONGO_ANALYTICS_PASSWORD', 'mongo-analytics-insecure-dev', nonEmpty(), true),
  rabbitmqUser: v('SCANTOR_RABBITMQ_USER', 'scantor', nonEmpty(), true),
  rabbitmqPassword: v('SCANTOR_RABBITMQ_PASSWORD', 'rabbitmq-insecure-dev', nonEmpty(), true),
  s3AccessKey: v('SCANTOR_S3_ACCESS_KEY', 'scantor', nonEmpty(), true),
  s3SecretKey: v('SCANTOR_S3_SECRET_KEY', 'rustfs-insecure-dev', nonEmpty(), true),
  s3Bucket: v('SCANTOR_S3_BUCKET', 'scantor', z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be an S3 bucket name'), true),

  composeProfiles: v('COMPOSE_PROFILES', '', fromParser(parseList), true),
  domain: v('SCANTOR_DOMAIN', '', z.union([z.literal(''), hostname()]).transform((value) => value || null), true),
  trustProxy: v('SCANTOR_TRUST_PROXY', 'false', boolean(), true),
  exposeMongo: v('SCANTOR_EXPOSE_MONGO', 'false', boolean(), true),

  imagePrefix: v('SCANTOR_IMAGE_PREFIX', 'ghcr.io/lonetis/', imagePrefix()),
  imageTag: v('SCANTOR_IMAGE_TAG', 'latest', imageTag()),
  components: v('SCANTOR_COMPONENTS', 'api,ingestor,reconciler', components(), true),
  logLevel: v('SCANTOR_LOG_LEVEL', 'info', oneOf(['debug', 'info', 'warn', 'error'])),
  logFormat: v('SCANTOR_LOG_FORMAT', 'json', oneOf(['json', 'text'])),
  passkeyRpId: v('SCANTOR_PASSKEY_RP_ID', '', z.union([z.literal(''), hostname()]).transform((value) => value || null), true),
  nodeStatusIntervalMs: v('SCANTOR_NODE_STATUS_INTERVAL', '10s', duration(1000)),
  nodeAssignmentsWaitMs: v('SCANTOR_NODE_ASSIGNMENTS_WAIT', '25s', duration(1000).pipe(z.number().max(60_000))),
  nodeOfflineAfterMs: v('SCANTOR_NODE_OFFLINE_AFTER', '60s', duration(5000)),
  nodeMinFreeDiskBytes: v('SCANTOR_NODE_MIN_FREE_DISK', '5GiB', byteSize()),
  placementMaxConcurrentPulls: v('SCANTOR_PLACEMENT_MAX_CONCURRENT_PULLS', '4', integer(1, 1000)),
  workerDrainGraceMs: v('SCANTOR_WORKER_DRAIN_GRACE', '30s', duration()),
  workerCapAdd: v('SCANTOR_WORKER_CAP_ADD', 'NET_BIND_SERVICE,NET_RAW', capabilities(), true),
  tombstoneDays: v('SCANTOR_TOMBSTONE_DAYS', '7', integer(1, 3650)),
  eventsTtlDays: v('SCANTOR_EVENTS_TTL_DAYS', '30', integer(1, 3650)),
  exportRetentionDays: v('SCANTOR_EXPORT_RETENTION_DAYS', '7', integer(1, 3650)),
  registryGcIntervalMs: v('SCANTOR_REGISTRY_GC_INTERVAL', '24h', duration()),

  maxRequestBytes: v('SCANTOR_MAX_REQUEST_BYTES', '10MiB', byteSize(1024)),
  maxUploadBytes: v('SCANTOR_MAX_UPLOAD_BYTES', '100MiB', byteSize(1)),
  maxScanConfigBytes: v('SCANTOR_MAX_SCAN_CONFIG_BYTES', '1MiB', byteSize(1)),
  maxConcurrentWaits: v('SCANTOR_MAX_CONCURRENT_WAITS', '20', integer(1, 10_000)),
  queryMaxTimeMs: v('SCANTOR_QUERY_MAX_TIME', '30s', duration(100)),
  queryMaxDocs: v('SCANTOR_QUERY_MAX_DOCS', '10000', integer(1, 10_000_000)),
  userMaxConcurrentQueries: v('SCANTOR_USER_MAX_CONCURRENT_QUERIES', '4', integer(1, 1000)),
  exportInlineMax: v('SCANTOR_EXPORT_INLINE_MAX', '50000', integer(0)),

  maxAnalysesPerScan: v('SCANTOR_MAX_ANALYSES_PER_SCAN', '20000000', integer(1)),
  maxWorkersPerScan: v('SCANTOR_MAX_WORKERS_PER_SCAN', '100', integer(1, 100_000)),
  maxProcessesPerWorker: v('SCANTOR_MAX_PROCESSES_PER_WORKER', '64', integer(1, 10_000)),
  userMaxWorkers: v('SCANTOR_USER_MAX_WORKERS', '0', integer(0)),
  authRateLimitScale: v('SCANTOR_AUTH_RATE_LIMIT_SCALE', '1', integer(1, 10000), true),
  maxAnalysisConfigBytes: v('SCANTOR_MAX_ANALYSIS_CONFIG_BYTES', '64KiB', byteSize(1)),
  maxResultBytes: v('SCANTOR_MAX_RESULT_BYTES', '1MiB', byteSize(1)),
  maxFileBytes: v('SCANTOR_MAX_FILE_BYTES', '1GiB', byteSize(1)),
  maxFilesPerAnalysis: v('SCANTOR_MAX_FILES_PER_ANALYSIS', '100', integer(0, 100_000)),
  userStorageQuotaBytes: v('SCANTOR_USER_STORAGE_QUOTA_BYTES', '0', byteSize()),
  uploadTimeoutMs: v('SCANTOR_UPLOAD_TIMEOUT', '15m', duration(1000)),
  workerMinFreeTmpBytes: v('SCANTOR_WORKER_MIN_FREE_TMP_BYTES', '1GiB', byteSize()),

  buildTimeoutMs: v('SCANTOR_BUILD_TIMEOUT', '30m', duration(1000)),
  buildConcurrency: v('SCANTOR_BUILD_CONCURRENCY', '2', integer(1, 1000)),
  maxImageBytes: v('SCANTOR_MAX_IMAGE_BYTES', '10GiB', byteSize(1)),
  buildCacheMaxBytes: v('SCANTOR_BUILD_CACHE_MAX_BYTES', '20GiB', byteSize()),
  describeTimeoutMs: v('SCANTOR_DESCRIBE_TIMEOUT', '10m', duration(1000)),
  taskMaxPackBytes: v('SCANTOR_TASK_MAX_PACK_BYTES', '50MiB', byteSize(1)),
  taskMaxFiles: v('SCANTOR_TASK_MAX_FILES', '5000', integer(1)),
  taskMaxBytes: v('SCANTOR_TASK_MAX_BYTES', '200MiB', byteSize(1)),

  testRunTimeoutMs: v('SCANTOR_TEST_RUN_TIMEOUT', '10m', duration(1000)),
  testRunConcurrency: v('SCANTOR_TEST_RUN_CONCURRENCY', '2', integer(1, 1000)),
  testRunRetentionDays: v('SCANTOR_TEST_RUN_RETENTION_DAYS', '7', integer(1, 3650)),
  draftImageRetentionMs: v('SCANTOR_DRAFT_IMAGE_RETENTION', '24h', duration()),

  deliveryLimit: v('SCANTOR_DELIVERY_LIMIT', '10', integer(1, 1000)),
  scanQueueMaxReady: v('SCANTOR_SCAN_QUEUE_MAX_READY', '100000', integer(1)),
  scanConfirmThreshold: v('SCANTOR_SCAN_CONFIRM_THRESHOLD', '100000', integer(0)),
  schedulerMaxRestarts: v('SCANTOR_SCHEDULER_MAX_RESTARTS', '3', integer(0, 1000)),
  scanStallAfterMs: v('SCANTOR_SCAN_STALL_AFTER', '5m', duration(1000)),

  ingestPrefetch: v('SCANTOR_INGEST_PREFETCH', '1000', integer(1, 65_535)),
  ingestBatchSize: v('SCANTOR_INGEST_BATCH_SIZE', '500', integer(1, 100_000)),
  ingestFlushIntervalMs: v('SCANTOR_INGEST_FLUSH_INTERVAL', '1s', duration(10)),
  ingestBatchMaxBytes: v('SCANTOR_INGEST_BATCH_MAX_BYTES', '16MiB', byteSize(1)),
  breakerMinAttempts: v('SCANTOR_BREAKER_MIN_ATTEMPTS', '100', integer(0)),
  breakerRatio: v('SCANTOR_BREAKER_RATIO', '0.95', decimal(0, 1)),
  breakerWindowMs: v('SCANTOR_BREAKER_WINDOW', '5m', duration(1000)),

  caCert: v('SCANTOR_CA_CERT', '', pem(), true),
  allowInsecureTransport: v('SCANTOR_ALLOW_INSECURE_TRANSPORT', 'false', boolean(), true),

  editorIdleTimeoutMs: v('SCANTOR_EDITOR_IDLE_TIMEOUT', '30m', duration(60_000)),
  editorMaxRunning: v('SCANTOR_EDITOR_MAX_RUNNING', '10', integer(0, 10_000)),
  editorStartTimeoutMs: v('SCANTOR_EDITOR_START_TIMEOUT', '60s', duration(1000)),
  editorApiKeyTtlMs: v('SCANTOR_EDITOR_API_KEY_TTL', '168h', duration(15 * 60_000)),
  editorMemoryLimitBytes: v('SCANTOR_EDITOR_MEMORY_LIMIT', '2GiB', byteSize(64 * 1024 ** 2)),
  editorCpus: v('SCANTOR_EDITOR_CPUS', '2', decimal(0.1, 1024)),
  editorPidsLimit: v('SCANTOR_EDITOR_PIDS_LIMIT', '1024', integer(16, 1_000_000)),
  editorTmpfsSizeBytes: v('SCANTOR_EDITOR_TMPFS_SIZE', '512MiB', byteSize(1024 ** 2)),

  workspaceMaxBytes: v('SCANTOR_WORKSPACE_MAX_BYTES', '2GiB', byteSize(1)),
  helperConcurrency: v('SCANTOR_HELPER_CONCURRENCY', '8', integer(1, 1000)),
  helperMemoryLimitBytes: v('SCANTOR_HELPER_MEMORY_LIMIT', '512MiB', byteSize(16 * 1024 ** 2)),
  helperPidsLimit: v('SCANTOR_HELPER_PIDS_LIMIT', '256', integer(8, 1_000_000)),
  helperTimeoutMs: v('SCANTOR_HELPER_TIMEOUT', '5m', duration(1000)),

  gitAllowPrivate: v('SCANTOR_GIT_ALLOW_PRIVATE', 'false', boolean(), true),

  mcpEnabled: v('SCANTOR_MCP_ENABLED', 'true', boolean(), true),
  mcpAllowedRedirectOrigins: v('SCANTOR_MCP_ALLOWED_REDIRECT_ORIGINS', '', httpsOrigins(), true),

  trancoUrl: v('SCANTOR_TRANCO_URL', 'https://tranco-list.eu', baseUrl()),
  cruxUrl: v('SCANTOR_CRUX_URL', 'https://raw.githubusercontent.com/zakird/crux-top-lists/main', baseUrl()),
} satisfies { [K in keyof Config]: VariableSpec<Config[K]> }

/** Every environment variable the orchestrator reads, for documentation checks (tests/scripts/lint-env.mjs). */
export const CONFIG_VARIABLES: readonly string[] = Object.values(VARIABLES).map((spec) => spec.name)

export interface ParsedConfig {
  config: Config
  warnings: ConfigIssue[]
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ')
}

/** Parses and cross-validates the configuration. Throws ConfigError for invalid security-relevant values. */
export function parseConfig(env: Env): ParsedConfig {
  const errors: ConfigIssue[] = []
  const warnings: ConfigIssue[] = []
  const values: Record<string, unknown> = {}

  for (const [key, spec] of Object.entries(VARIABLES) as [keyof Config, VariableSpec<unknown>][]) {
    const raw = env[spec.name]
    const result = spec.schema.safeParse(raw ?? spec.fallback)
    if (result.success) {
      values[key] = result.data
      continue
    }
    const issue = { variable: spec.name, message: formatIssues(result.error) }
    if (spec.security) {
      errors.push(issue)
      continue
    }
    warnings.push({ variable: spec.name, message: `${issue.message}; using the default` })
    values[key] = spec.schema.parse(spec.fallback)
  }
  if (errors.length > 0) throw new ConfigError(errors)

  const config = values as unknown as Config
  errors.push(...crossValidate(config))
  if (errors.length > 0) throw new ConfigError(errors)
  return { config, warnings }
}

function crossValidate(config: Config): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  if ((config.adminEmail === null) !== (config.adminPassword === null)) {
    issues.push({
      variable: config.adminEmail === null ? 'SCANTOR_ADMIN_EMAIL' : 'SCANTOR_ADMIN_PASSWORD',
      message: 'SCANTOR_ADMIN_EMAIL and SCANTOR_ADMIN_PASSWORD must be set together',
    })
  }
  if (config.passkeyRpId !== null) {
    const host = new URL(config.publicUrl).hostname
    if (config.passkeyRpId !== host && !(host.endsWith(`.${config.passkeyRpId}`) && config.passkeyRpId.includes('.'))) {
      issues.push({
        variable: 'SCANTOR_PASSKEY_RP_ID',
        message: `must equal the host of SCANTOR_PUBLIC_URL (${host}) or be a registrable suffix of it`,
      })
    }
  }
  return issues
}

// ── process configuration ─────────────────────────────────────────────────────

let cached: Config | null = null

/** The parsed configuration of this process (parsed once from process.env). Throws ConfigError when invalid. */
export function useConfig(): Config {
  cached ??= parseConfig(process.env).config
  return cached
}

export interface BootConfiguration {
  config: Config
  warnings: ConfigIssue[]
  guard: StartupGuardResult
}

/**
 * Boot step 1 (docs/architecture.md §4.1): parse every variable and evaluate the startup guard of security.md
 * CFG-2 over the whole environment. The caller logs the result and exits on `guard.outcome === 'abort'`.
 */
export function loadBootConfiguration(): BootConfiguration {
  const { config, warnings } = parseConfig(process.env)
  cached = config
  const guard = evaluateStartupGuard({
    publicUrl: config.publicUrl,
    editorUrl: config.editorUrl,
    bindAddress: config.bindAddress,
    adminBindAddress: config.adminBindAddress,
    composeProfiles: config.composeProfiles,
    exposeMongo: config.exposeMongo,
    allowInsecureDefaults: config.allowInsecureDefaults,
    env: { ...process.env },
  })
  return { config, warnings, guard }
}

/** Test seam: replaces the process configuration. */
export function setConfigForTesting(config: Config | null): void {
  cached = config
}
