import { randomUUID } from 'node:crypto'
import type { RestartScanBody, StartScanBody } from '#shared/schemas/scans'
import type { ValidationIssue } from '#shared/types/common'
import { isUuid } from '#shared/utils/slug'
import type { DescriptionDoc, RevisionDoc, ScanDoc, ScanSettingsDoc } from '../../types/documents'
import type { Config } from '../../utils/config'
import { ApiError, apiError, validationError } from '../../utils/errors'
import { useLogger } from '../../utils/logger'
import { useCollections } from '../../utils/mongo'
import type { UserPrincipal } from '../../utils/principal'
import { expandPointer, parsePointer } from '../../utils/secrets'
import { estimateTemplate } from '../catalog/estimate'
import { mergeSettings, settingsIssues } from '../configs/settings'
import { type ConfigObject, rebindConfigSecrets, restoreConfigSecrets, type SecretBinding, validateConfigs } from '../configs/validate'
import { resolveRevisionRef } from '../revisions/resolve'
import { assertPrivilegedAllowed, loadScanRevision } from './access'
import { assertNoBrokerAlarm } from './broker'
import { writeEvent } from './events'
import { revisionRef } from './mappers'
import { decideTransition } from './state-machine'

/*
 * startScan and restartScan (docs/api.md §5.1, §4.13; docs/architecture.md §11.2 step 1, §11.3 "restart"). The
 * validation order of startScan is normative:
 *
 *   1 body schema (400, the route)  2 revision reference (404)  3 revision ready (409 revisionNotReady)
 *   4 privileged (403)  5 broker alarm (503)  6 configs (422 configInvalid)  7 settings bounds (400)
 *   8 upload references (404)  9 estimate for template schedules (422)  10 insert `creating`, event scan.created
 *
 * A restart clones the original scan (same revision, effective configs and secrets, settings with workers/processes/
 * name overrides) into a new scan that runs the normal start flow; templates resolve again.
 */

export const MAX_UPLOAD_IDS = 32

function scanBinding(scanId: string): SecretBinding {
  return { collection: 'scans', id: scanId }
}

/** JSON byte size of a config; task and scan configs are capped by SCANTOR_MAX_SCAN_CONFIG_BYTES each. */
export function configSizeIssues(body: Pick<StartScanBody, 'taskConfig' | 'scanConfig'>, maxBytes: number): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const kind of ['taskConfig', 'scanConfig'] as const) {
    const value = body[kind]
    if (value === undefined) continue
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (bytes > maxBytes) issues.push({ path: kind, message: `must be at most ${maxBytes} bytes of JSON (got ${bytes})` })
  }
  return issues
}

/** Upload ids referenced by the effective configs at the `"x-scantor": "upload"` paths of describe. */
export function referencedUploadIds(description: Pick<DescriptionDoc, 'uploadPaths'>, configs: { taskConfig: ConfigObject; scanConfig: ConfigObject }): string[] {
  const ids = new Set<string>()
  for (const kind of ['taskConfig', 'scanConfig'] as const) {
    for (const pattern of description.uploadPaths?.[kind] ?? []) {
      for (const pointer of expandPointer(configs[kind], pattern)) {
        let node: unknown = configs[kind]
        for (const segment of parsePointer(pointer)) node = (node as Record<string, unknown> | null)?.[segment]
        if (typeof node === 'string' && node !== '') ids.add(node)
      }
    }
  }
  return [...ids]
}

/** Step 8: every referenced upload exists and belongs to the scan owner (404 otherwise). */
async function assertUploadsOwned(ids: string[], ownerId: string): Promise<void> {
  if (ids.length === 0) return
  if (ids.length > MAX_UPLOAD_IDS) throw validationError([{ path: 'scanConfig', message: `at most ${MAX_UPLOAD_IDS} uploads may be referenced` }])
  const malformed = ids.find((id) => !isUuid(id))
  if (malformed) throw apiError('notFound', `upload ${malformed} not found`)
  const { uploads } = useCollections()
  const found = await uploads.find({ _id: { $in: ids }, userId: ownerId }, { projection: { _id: 1 } }).toArray()
  const known = new Set(found.map((upload) => upload._id))
  const missing = ids.find((id) => !known.has(id))
  if (missing) throw apiError('notFound', `upload ${missing} not found`)
  await uploads.updateMany({ _id: { $in: ids }, userId: ownerId }, { $set: { lastUsedAt: new Date(), updatedAt: new Date() } })
}

/** Moves estimate issues below `/scanConfig` (the request body), whatever the estimator reported. */
function prefixEstimateIssues(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.code !== 'configInvalid') return error
  const issues = (error.details?.issues as ValidationIssue[] | undefined) ?? []
  const prefixed = issues.map((issue) => ({ ...issue, path: issue.path.startsWith('/scanConfig') ? issue.path : `/scanConfig${issue.path}` }))
  return apiError('configInvalid', error.message, { ...error.details, issues: prefixed })
}

interface EstimateOutcome {
  expectedTotal: number | null
}

/** Step 9 (template schedules only): scanTooLarge above the maximum, confirmationRequired above the threshold. */
async function estimate(
  schedule: DescriptionDoc['schedule'],
  scanConfig: ConfigObject,
  config: Pick<Config, 'maxAnalysesPerScan' | 'scanConfirmThreshold'>,
  confirm: boolean | 'notRequired',
): Promise<EstimateOutcome> {
  if (schedule.kind !== 'template' || !schedule.template) return { expectedTotal: null }
  let result: Awaited<ReturnType<typeof estimateTemplate>>
  try {
    result = await estimateTemplate(schedule.template, scanConfig)
  } catch (error) {
    throw prefixEstimateIssues(error)
  }
  const expectedTotal = result.expectedTotal
  if (expectedTotal !== null && (result.tooLarge || expectedTotal > config.maxAnalysesPerScan)) {
    throw apiError('scanTooLarge', `the scan would create about ${expectedTotal} analyses; the maximum is ${config.maxAnalysesPerScan}`, {
      expectedTotal,
      max: config.maxAnalysesPerScan,
    })
  }
  const needsConfirmation = expectedTotal !== null && (result.confirmationRequired || expectedTotal > config.scanConfirmThreshold)
  if (needsConfirmation && confirm === false) {
    throw apiError('confirmationRequired', `the scan would create about ${expectedTotal} analyses; repeat the request with confirm: true`, {
      expectedTotal,
      threshold: config.scanConfirmThreshold,
    })
  }
  return { expectedTotal }
}

interface ScanDocInput {
  id: string
  userId: string
  name: string | null
  task: ScanDoc['task']
  revision: ScanDoc['revision']
  taskConfig: ConfigObject
  scanConfig: ConfigObject
  secrets: ScanDoc['secrets']
  secretPaths: ScanDoc['secretPaths']
  uploadIds: string[]
  settings: ScanSettingsDoc
  expectedTotal: number | null
  clonedFrom: string | null
  now: Date
}

export function buildScanDoc(input: ScanDocInput): ScanDoc {
  return {
    _id: input.id,
    userId: input.userId,
    name: input.name,
    task: input.task,
    revision: input.revision,
    state: 'creating',
    stateReason: null,
    taskConfig: input.taskConfig,
    scanConfig: input.scanConfig,
    secrets: input.secrets,
    secretPaths: input.secretPaths,
    uploadIds: input.uploadIds,
    settings: input.settings,
    round: 1,
    scheduling: {
      state: 'pending',
      confirmed: 0,
      tailHash: null,
      epoch: 0,
      restarts: 0,
      resolved: {},
      error: null,
      startedAt: null,
      checkpointAt: null,
      doneAt: null,
    },
    stats: { pending: 0, retrying: 0, succeeded: 0, failed: 0, lost: 0, cancelled: 0, expectedTotal: input.expectedTotal, ratePerMin: 0, recountedAt: null },
    conditions: [],
    breaker: null,
    clonedFrom: input.clonedFrom,
    createdAt: input.now,
    updatedAt: input.now,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    deletedAt: null,
  }
}

/** The denormalised revision of a scan (docs/data-model.md §4.5). */
export function scanRevisionOf(revision: RevisionDoc): ScanDoc['revision'] {
  const image = revision.image!
  return {
    id: revision._id,
    number: revision.number,
    language: revision.language ?? '',
    repository: image.repository,
    digest: image.digest,
    platform: { os: image.platform.os, arch: image.platform.arch },
    privileged: revision.privileged,
    schedule: { ...revision.description!.schedule },
  }
}

function assertSettings(settings: ScanSettingsDoc, config: Config): void {
  const issues = settingsIssues(settings, config)
  if (issues.length > 0) throw validationError(issues, 'scan settings out of bounds')
}

async function insertScan(scan: ScanDoc): Promise<ScanDoc> {
  await useCollections().scans.insertOne(scan)
  useLogger('scans').info('scan created', { scanId: scan._id, userId: scan.userId, revision: revisionRef(scan), clonedFrom: scan.clonedFrom ?? undefined })
  await writeEvent({
    type: 'scan.created',
    level: 'info',
    userId: scan.userId,
    scanId: scan._id,
    taskId: scan.task.id,
    revisionId: scan.revision.id,
    message: `scan of ${revisionRef(scan)} created${scan.clonedFrom ? ` (restart of ${scan.clonedFrom})` : ''}`,
    data: { revision: revisionRef(scan), settings: scan.settings },
  })
  return scan
}

/** POST /api/scans after the body passed its schema (step 1). Returns the inserted `creating` scan. */
export async function startScan(principal: UserPrincipal, body: StartScanBody, config: Config): Promise<ScanDoc> {
  const sizeIssues = configSizeIssues(body, config.maxScanConfigBytes)
  if (sizeIssues.length > 0) throw validationError(sizeIssues)

  const revision = await resolveRevisionRef(principal, body.revision) // 2, 3
  if (revision.state !== 'ready' || !revision.image || !revision.description) {
    throw apiError('revisionNotReady', `revision ${revision.taskName}@${revision.number} is ${revision.state}`, { state: revision.state })
  }
  const ownerId = principal.user.id
  await assertPrivilegedAllowed(revision.privileged, ownerId) // 4
  await assertNoBrokerAlarm() // 5

  const scanId = randomUUID()
  const configs = await validateConfigs(revision.description, { taskConfig: body.taskConfig, scanConfig: body.scanConfig }, scanBinding(scanId)) // 6
  const settings = mergeSettings(revision.settingsDefaults, body.settings, revision.privileged)
  assertSettings(settings, config) // 7
  const uploadIds = referencedUploadIds(revision.description, configs.effective)
  await assertUploadsOwned(uploadIds, ownerId) // 8
  const { expectedTotal } = await estimate(revision.description.schedule, configs.effective.scanConfig, config, body.confirm === true) // 9

  return insertScan(
    buildScanDoc({
      id: scanId,
      userId: ownerId,
      name: body.name ?? null,
      task: { id: revision.taskId, name: revision.taskName },
      revision: scanRevisionOf(revision),
      taskConfig: configs.masked.taskConfig,
      scanConfig: configs.masked.scanConfig,
      secrets: { taskConfig: configs.secrets.taskConfig, scanConfig: configs.secrets.scanConfig },
      secretPaths: revision.description.secretPaths,
      uploadIds,
      settings,
      expectedTotal,
      clonedFrom: null,
      now: new Date(),
    }),
  ) // 10
}

/** POST /api/scans/{scanId}/restart: a new scan cloned from `original` (owned by the original's owner). */
export async function restartScan(original: ScanDoc, body: RestartScanBody, config: Config): Promise<ScanDoc> {
  decideTransition('restart', original)
  await loadScanRevision(original)
  await assertPrivilegedAllowed(original.revision.privileged, original.userId)
  await assertNoBrokerAlarm()

  const settings: ScanSettingsDoc = {
    ...original.settings,
    workers: body.settings?.workers ?? original.settings.workers,
    processes: body.settings?.processes ?? original.settings.processes,
  }
  assertSettings(settings, config)
  await assertUploadsOwned(original.uploadIds, original.userId)

  const scanId = randomUUID()
  const plaintext = restoreConfigSecrets({ taskConfig: original.taskConfig, scanConfig: original.scanConfig }, original.secrets, scanBinding(original._id))
  const { expectedTotal } = await estimate(original.revision.schedule, plaintext.scanConfig, config, 'notRequired')
  const secrets = rebindConfigSecrets(original.secrets, scanBinding(original._id), scanBinding(scanId))

  const clone = await insertScan(
    buildScanDoc({
      id: scanId,
      userId: original.userId,
      name: body.name ?? original.name ?? null,
      task: { ...original.task },
      revision: { ...original.revision },
      taskConfig: structuredClone(original.taskConfig),
      scanConfig: structuredClone(original.scanConfig),
      secrets: { taskConfig: secrets.taskConfig, scanConfig: secrets.scanConfig },
      secretPaths: structuredClone(original.secretPaths),
      uploadIds: [...original.uploadIds],
      settings,
      expectedTotal,
      clonedFrom: original._id,
      now: new Date(),
    }),
  )
  await writeEvent({
    type: 'scan.restarted',
    level: 'info',
    userId: original.userId,
    scanId: original._id,
    message: `restarted as scan ${clone._id}`,
    data: { newScanId: clone._id },
  })
  return clone
}
