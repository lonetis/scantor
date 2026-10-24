import languagesTable from '../../../../schemas/languages.json'
import type { EndpointProfile } from '#shared/utils/enums'
import type { NodeDoc, RevisionDoc, ScanDoc, WorkerDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { useKeys } from '../../utils/keys'
import type { Logger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { WorkerPrincipal } from '../../utils/principal'
import { presignGet } from '../../utils/s3'
import { configSecretAad, restoreSecrets, SecretDecryptionError } from '../../utils/secrets'
import { isoDate } from '../../utils/serialize'
import { EXCHANGES, scanAmqpUser, scanQueueName } from '../../utils/amqp'
import { RABBITMQ_VHOST } from '../../utils/rabbitmq-management'
import { recordEvent } from '../nodes/events'
import { endpointUrls } from '../nodes/profile'
import { allowedProcesses, runtimeAction, type RuntimeAction, STATE_POLL_MS } from './state'
import { mergeRuntime } from './worker-runtime'

// GET /api/runtime/bootstrap (docs/api.md §8.1, docs/runtime.md §4): everything a worker needs, computed for the
// endpoint profile of its node (docs/architecture.md §8): effective configs with decrypted writeOnly secrets
// (runners get only the task config), the per-scan AMQP credentials, limits, intervals and, for the scheduler, the
// restart count, checkpoint, stored resolutions, presigned upload GETs and data-source URLs. The first bootstrap
// moves the worker to `running` and a pending scheduling to `running`.

export const AMQP_HEARTBEAT_SECONDS = 30
export const CONSUMER_TIMEOUT_MARGIN_MS = 300_000
export const UPLOAD_SOURCE_TTL_SECONDS = 3600
const BOOTSTRAP_WORKER_STATES = ['assigned', 'pulling', 'starting', 'backoff'] as const

export type BootstrapConfig = Pick<
  Config,
  | 'internalUrl'
  | 'publicUrl'
  | 'amqpInternalUrl'
  | 'amqpPublicUrl'
  | 'registryPort'
  | 'registryPublicHost'
  | 'uploadTimeoutMs'
  | 'maxFileBytes'
  | 'maxFilesPerAnalysis'
  | 'maxAnalysisConfigBytes'
  | 'maxResultBytes'
  | 'maxAnalysesPerScan'
  | 'maxProcessesPerWorker'
  | 'workerMinFreeTmpBytes'
  | 'workerDrainGraceMs'
  | 'scanQueueMaxReady'
  | 'trancoUrl'
  | 'cruxUrl'
>

const languages = (languagesTable as { languages: Record<string, { entry: string }> }).languages

/** The revision's normalised manifest entry, or the language default (docs/api.md §8.1 `revision.entry`). */
export function revisionEntry(revision: Pick<RevisionDoc, 'manifest'> | null, language: string): string {
  const entry = revision?.manifest?.entry
  if (typeof entry === 'string' && entry.length > 0) return entry
  const fallback = languages[language]?.entry
  if (!fallback) throw new Error(`no default entry for language ${language}`)
  return fallback
}

export interface UploadSource {
  url: string
  sha256: string
  bytes: number
  expiresAt: string
}

export interface BootstrapParts {
  now: Date
  action: RuntimeAction
  worker: WorkerDoc
  scan: ScanDoc
  revision: Pick<RevisionDoc, 'manifest' | 'description'> | null
  profile: EndpointProfile
  config: BootstrapConfig
  /** plaintext effective configs (secrets restored) */
  taskConfig: Record<string, unknown>
  scanConfig: Record<string, unknown>
  amqpPassword: string
  uploads: Record<string, UploadSource>
}

/** The bootstrap document (pure; docs/api.md §8.1). */
export function buildBootstrap(parts: BootstrapParts) {
  const { worker, scan, config } = parts
  const urls = endpointUrls(parts.profile, config)
  const scheduler = worker.role === 'scheduler'
  const settings = scan.settings
  return {
    serverTime: parts.now.getTime(),
    action: parts.action,
    worker: { id: worker._id, role: worker.role, scanId: scan._id, nodeId: worker.nodeId!, epoch: scheduler ? worker.epoch : 0 },
    scan: {
      id: scan._id,
      state: scan.state,
      round: scan.round,
      taskConfig: parts.taskConfig,
      ...(scheduler ? { scanConfig: parts.scanConfig } : {}),
      settings: {
        processes: allowedProcesses(worker, config.maxProcessesPerWorker),
        timeoutMs: settings.timeoutMs,
        maxAttempts: settings.maxAttempts,
        backoff: settings.backoff,
        resources: settings.resources,
        maxAnalysesPerProcess: settings.maxAnalysesPerProcess,
      },
    },
    revision: {
      id: scan.revision.id,
      number: scan.revision.number,
      entry: revisionEntry(parts.revision, scan.revision.language),
      protocolVersion: parts.revision?.description?.protocolVersion ?? 1,
      schedule: scan.revision.schedule,
    },
    amqp: {
      url: urls.amqpUrl,
      vhost: RABBITMQ_VHOST,
      username: scanAmqpUser(scan._id),
      password: parts.amqpPassword,
      queue: scanQueueName(scan._id),
      analysesExchange: EXCHANGES.analyses,
      resultsExchange: EXCHANGES.results,
      routingKey: scan._id,
      heartbeatSeconds: AMQP_HEARTBEAT_SECONDS,
      consumerTimeoutMs: settings.timeoutMs + config.uploadTimeoutMs + CONSUMER_TIMEOUT_MARGIN_MS,
      // The x-max-length of scan queues (../reconciler/topology.ts); the scheduler keeps half of it.
      maxLength: config.scanQueueMaxReady,
    },
    uploads: { mode: 'presigned' as const, maxFileBytes: config.maxFileBytes, maxFilesPerAnalysis: config.maxFilesPerAnalysis, timeoutMs: config.uploadTimeoutMs },
    limits: {
      maxAnalysisConfigBytes: config.maxAnalysisConfigBytes,
      maxResultBytes: config.maxResultBytes,
      maxResultMessageBytes: 2 * 1024 * 1024,
      logTailBytes: 32 * 1024,
      logTailEarlierBytes: 4 * 1024,
      stackBytes: 16 * 1024,
      maxAnalysesPerScan: config.maxAnalysesPerScan,
      maxProcessesPerWorker: config.maxProcessesPerWorker,
      minFreeTmpBytes: config.workerMinFreeTmpBytes,
    },
    intervals: {
      statePollMs: STATE_POLL_MS,
      statePollJitter: 0.2,
      checkpointMs: 5000,
      checkpointItems: 1000,
      drainGraceMs: config.workerDrainGraceMs,
      backpressureWaitMs: 2000,
    },
    scheduler: scheduler
      ? {
          restarts: scan.scheduling.restarts,
          checkpoint: { confirmed: scan.scheduling.confirmed, tailHash: scan.scheduling.tailHash },
          resolved: Object.fromEntries(
            Object.entries(scan.scheduling.resolved ?? {}).map(([key, resolution]) => [key, { ...resolution, at: isoDate(resolution.at) }]),
          ),
          uploads: parts.uploads,
          dataSources: { tranco: config.trancoUrl, crux: config.cruxUrl },
        }
      : null,
  }
}

export type Bootstrap = ReturnType<typeof buildBootstrap>

/** Restores the plaintext of a scan config from its masked form and encrypted `writeOnly` values. */
export function plaintextConfig(scan: ScanDoc, kind: 'taskConfig' | 'scanConfig'): Record<string, unknown> {
  return restoreSecrets(scan[kind] ?? {}, scan.secrets?.[kind] ?? {}, (pointer) => configSecretAad('scans', scan._id, kind, pointer))
}

async function uploadSources(scan: ScanDoc, profile: EndpointProfile): Promise<Record<string, UploadSource>> {
  if (scan.uploadIds.length === 0) return {}
  const docs = await useCollections().uploads.find({ _id: { $in: scan.uploadIds }, userId: scan.userId }).toArray()
  const sources: Record<string, UploadSource> = {}
  for (const upload of docs) {
    const { url, expiresAt } = await presignGet({ key: upload.key, expiresInSeconds: UPLOAD_SOURCE_TTL_SECONDS, profile })
    sources[upload._id] = { url, sha256: upload.sha256, bytes: upload.bytes, expiresAt: isoDate(expiresAt) }
  }
  return sources
}

export interface BootstrapResult {
  serverTime: number
  action: RuntimeAction
  [key: string]: unknown
}

export async function handleBootstrap(principal: WorkerPrincipal, runtimeVersion: string | null, config: BootstrapConfig, log: Logger): Promise<BootstrapResult> {
  const { workers, scans, nodes, revisions } = useCollections()
  const { worker: identity } = principal
  const [worker, scan, node] = await Promise.all([
    workers.findOne({ _id: identity.id }),
    scans.findOne({ _id: identity.scanId }),
    nodes.findOne({ _id: identity.nodeId }, { projection: { endpointProfile: 1 } }) as Promise<Pick<NodeDoc, '_id' | 'endpointProfile'> | null>,
  ])
  if (!worker) throw apiError('unauthorized', 'worker no longer exists')
  const now = new Date()
  const stopIdentity = { id: identity.id, role: identity.role, scanId: identity.scanId, nodeId: identity.nodeId, epoch: identity.epoch }
  if (!scan || !node) return { serverTime: now.getTime(), action: 'stop', worker: stopIdentity }

  let action = runtimeAction({
    scanState: scan.state,
    workerState: worker.state,
    role: worker.role,
    workerEpoch: worker.epoch,
    schedulingState: scan.scheduling.state,
    schedulingEpoch: scan.scheduling.epoch,
  })
  // A draining worker has nothing to finish yet: it simply does not start.
  if (action === 'drain' || scan.state !== 'running') action = 'stop'
  if (action === 'stop') return { serverTime: now.getTime(), action, worker: stopIdentity }

  const revision = await revisions.findOne({ _id: scan.revision.id }, { projection: { manifest: 1, description: 1 } })
  let taskConfig: Record<string, unknown>
  let scanConfig: Record<string, unknown>
  try {
    taskConfig = plaintextConfig(scan, 'taskConfig')
    scanConfig = worker.role === 'scheduler' ? plaintextConfig(scan, 'scanConfig') : {}
  } catch (error) {
    if (error instanceof SecretDecryptionError) {
      log.error('a writeOnly config value of the scan cannot be decrypted (was SCANTOR_SECRET changed?)', { scanId: scan._id })
      throw apiError('internal', 'the scan configuration cannot be decrypted')
    }
    throw error
  }
  const uploads = worker.role === 'scheduler' ? await uploadSources(scan, node.endpointProfile) : {}

  const bootstrap = buildBootstrap({
    now,
    action,
    worker,
    scan,
    revision,
    profile: node.endpointProfile,
    config,
    taskConfig,
    scanConfig,
    amqpPassword: useKeys().amqpPassword(scan._id),
    uploads,
  })
  await recordBootstrap(worker, scan, runtimeVersion, revision?.description?.protocolVersion ?? null, now, log)
  return bootstrap
}

/** Effects of a successful bootstrap: worker `running`, runtime facts, scheduling `pending → running`. */
async function recordBootstrap(worker: WorkerDoc, scan: ScanDoc, runtimeVersion: string | null, protocolVersion: number | null, now: Date, log: Logger): Promise<void> {
  const { workers, scans } = useCollections()
  const runtimeFields = { version: runtimeVersion, protocolVersion, bootstrappedAt: now, lastSeenAt: now }
  const started = await workers.updateOne(
    { _id: worker._id, state: { $in: [...BOOTSTRAP_WORKER_STATES] } },
    [
      {
        $set: {
          state: 'running',
          stateReason: null,
          startedAt: { $ifNull: ['$startedAt', now] },
          runtime: mergeRuntime(runtimeFields),
          updatedAt: now,
        },
      },
    ],
  )
  if (started.modifiedCount === 0) {
    await workers.updateOne({ _id: worker._id }, [{ $set: { runtime: mergeRuntime(runtimeFields), updatedAt: now } }])
  } else {
    await recordEvent({
      type: 'worker.started',
      level: 'info',
      userId: worker.userId,
      scanId: scan._id,
      workerId: worker._id,
      nodeId: worker.nodeId ?? undefined,
      message: `${worker.role} worker started (runtime ${runtimeVersion ?? 'unknown'})`,
      data: { nodeId: worker.nodeId },
      at: now,
    }, log)
  }
  if (worker.role === 'scheduler') {
    await scans.updateOne(
      { _id: scan._id, 'scheduling.epoch': worker.epoch, 'scheduling.state': 'pending' },
      { $set: { 'scheduling.state': 'running', 'scheduling.startedAt': now, updatedAt: now } },
    )
  }
}
