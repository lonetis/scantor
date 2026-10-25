import { randomUUID } from 'node:crypto'
import type { TestTaskBody } from '#shared/schemas/tasks'
import type { TaskDoc, TestRunDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { apiError } from '../../utils/errors'
import { createJob } from '../../utils/jobs'
import { useCollections } from '../../utils/mongo'
import { decryptSecret, encryptSecret } from '../../utils/secrets'
import { SETTINGS_FALLBACKS } from '../configs/settings'
import type { ConfigSecrets } from '../configs/validate'

// Test-run creation (`testTask`, docs/tasks.md §11.1 step 1, docs/data-model.md §4.3): inserts the test run `queued`
// with its `testRun` job. Which config values are secrets is known only once the draft image is described, so the
// requested configs are kept encrypted as a whole (`secrets.request`) until the run is terminal; each job attempt
// validates them, then `input` holds the masked configs and `secrets` also the encrypted `writeOnly` values per
// pointer.

export const REQUEST_SECRET_KEY = 'request'

export interface RequestedConfigs {
  taskConfig?: Record<string, unknown>
  scanConfig?: Record<string, unknown>
  analysisConfig?: Record<string, unknown>
  /** present when the caller chose the per-analysis timeout (otherwise the manifest default applies) */
  timeoutMs?: number
}

export function requestAad(testRunId: string): string {
  return `testRuns:${testRunId}:/${REQUEST_SECRET_KEY}`
}

export function sealRequest(testRunId: string, request: RequestedConfigs): Record<string, Record<string, string>> {
  return { [REQUEST_SECRET_KEY]: { '': encryptSecret(JSON.stringify(request), 'config-secrets', requestAad(testRunId)) } }
}

export function openRequest(doc: Pick<TestRunDoc, '_id' | 'secrets'>): RequestedConfigs | null {
  const sealed = doc.secrets?.[REQUEST_SECRET_KEY]?.['']
  if (!sealed) return null
  return JSON.parse(decryptSecret(sealed, 'config-secrets', requestAad(doc._id))) as RequestedConfigs
}

/**
 * The `$set`/`$unset` fields that store the validated per-pointer secrets of an attempt next to `secrets.request`,
 * which they never replace (a restarted attempt validates the request again).
 */
export function validatedSecretsUpdate(secrets: ConfigSecrets): { set: Record<string, Record<string, string>>; unset: Record<string, ''> } {
  return {
    set: {
      'secrets.taskConfig': secrets.taskConfig,
      'secrets.scanConfig': secrets.scanConfig,
      ...(secrets.analysisConfig ? { 'secrets.analysisConfig': secrets.analysisConfig } : {}),
    },
    unset: secrets.analysisConfig ? {} : { 'secrets.analysisConfig': '' },
  }
}

function configBytes(value: unknown): number {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Inserts a queued test run of the current workspace and its `testRun` job. */
export async function createTestRun(task: TaskDoc, body: TestTaskBody, config: Pick<Config, 'maxScanConfigBytes' | 'testRunRetentionDays'>): Promise<TestRunDoc> {
  for (const kind of ['taskConfig', 'scanConfig', 'analysisConfig'] as const) {
    const bytes = configBytes(body[kind])
    if (bytes > config.maxScanConfigBytes) throw apiError('payloadTooLarge', `${kind} exceeds ${config.maxScanConfigBytes} bytes`, { limit: config.maxScanConfigBytes, actual: bytes })
  }
  const { testRuns, revisions } = useCollections()
  const latest = task.latestRevision ? await revisions.findOne({ _id: task.latestRevision.id }, { projection: { settingsDefaults: 1 } }) : null
  const id = randomUUID()
  const now = new Date()
  const request: RequestedConfigs = {
    ...(body.taskConfig === undefined ? {} : { taskConfig: body.taskConfig }),
    ...(body.scanConfig === undefined ? {} : { scanConfig: body.scanConfig }),
    ...(body.analysisConfig === undefined ? {} : { analysisConfig: body.analysisConfig }),
    ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
  }
  const { job } = await createJob({ kind: 'testRun', userId: task.userId, subject: { kind: 'testRun', id }, params: { testRunId: id } })
  const doc: TestRunDoc = {
    _id: id,
    userId: task.userId,
    taskId: task._id,
    taskName: task.name,
    state: 'queued',
    input: {
      limit: body.limit,
      maxAttempts: body.maxAttempts,
      // Provisional until the draft is described: the requested value, else the last known manifest default.
      timeoutMs: body.timeoutMs ?? latest?.settingsDefaults?.timeoutMs ?? SETTINGS_FALLBACKS.timeoutMs,
    },
    secrets: sealRequest(id, request),
    packSha256: null,
    draftImage: null,
    description: null,
    errors: [],
    summary: { analyses: 0, succeeded: 0, failed: 0 },
    buildLogKey: `test-runs/${id}/build.ndjson`,
    logKey: `test-runs/${id}/log.ndjson`,
    jobId: job._id,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + config.testRunRetentionDays * 86_400_000),
  }
  await testRuns.insertOne(doc)
  return doc
}
