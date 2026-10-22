import { z } from 'zod'
import { SCAN_STATES, WORKER_STATES } from '../utils/enums'
import { NODE_LABEL_KEY_PATTERN, NODE_LABEL_VALUE_MAX_LENGTH, SLUG_PATTERN } from '../utils/slug'
import { cursorQuery, MAX_PAGE_LIMIT, qInt, qList, text, userIdFilterShape, waitQueryShape } from './common'

// Request schemas of the `scans` tag (docs/api.md §4.13, §5.1). Static bounds of ScanSettings live here
// (docs/data-model.md §4.5.1); the instance limits SCANTOR_MAX_WORKERS_PER_SCAN and SCANTOR_MAX_PROCESSES_PER_WORKER
// are checked by the server after the settings are merged over the revision defaults (step 7 of §5.1). The UI
// validates the static parts of the new-scan form with the same schemas.

export const SCAN_NAME_MAX_LENGTH = 100
export const NODE_SELECTOR_LABELS_MAX = 16
export const MAX_TIMEOUT_MS = 86_400_000
export const WORKER_LOGS_DEFAULT_TAIL_BYTES = 65_536
export const WORKER_LOGS_MAX_TAIL_BYTES = 262_144
export const WORKER_LOGS_MAX_WAIT_SECONDS = 30

export const scanIdParams = z.strictObject({ scanId: z.uuid() })
export const workerLogsParams = z.strictObject({ scanId: z.uuid(), workerId: z.uuid() })

/** A plain JSON object (task or scan config); its size and content are checked against the revision schema. */
const configObject = () => z.record(z.string(), z.unknown())

const nodeSelectorLabels = z
  .record(
    z.string().regex(NODE_LABEL_KEY_PATTERN, 'must be a label key'),
    z.string().max(NODE_LABEL_VALUE_MAX_LENGTH),
  )
  .refine((labels) => Object.keys(labels).length <= NODE_SELECTOR_LABELS_MAX, `at most ${NODE_SELECTOR_LABELS_MAX} labels`)

/** The workers and processes of a scale or restart request (instance limits are checked by the server). */
export const scalingShape = {
  workers: z.number().int().min(1).max(100_000).optional(),
  processes: z.number().int().min(1).max(10_000).optional(),
}

/** Partial ScanSettings without `privileged` (merged over the revision's settingsDefaults). */
export const scanSettingsInput = z.strictObject({
  ...scalingShape,
  timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  backoff: z
    .strictObject({
      initialMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
      factor: z.number().min(1).max(10).optional(),
      maxMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
      jitter: z.boolean().optional(),
    })
    .optional(),
  resources: z
    .strictObject({
      cpus: z.number().min(0.1).max(64).optional(),
      memoryMiB: z.number().int().min(64).max(65_536).optional(),
    })
    .optional(),
  maxAnalysesPerProcess: z.number().int().min(1).max(1_000_000).optional(),
  nodeSelector: z
    .strictObject({
      pool: z.string().regex(SLUG_PATTERN, 'must be a pool slug').optional(),
      labels: nodeSelectorLabels.optional(),
    })
    .optional(),
})
export type ScanSettingsInput = z.infer<typeof scanSettingsInput>

/** `StartScan` (docs/api.md §4.13). */
export const startScanBody = z.strictObject({
  revision: z.string().trim().min(1).max(200),
  name: text(SCAN_NAME_MAX_LENGTH).optional(),
  taskConfig: configObject().optional(),
  scanConfig: configObject().optional(),
  settings: scanSettingsInput.optional(),
  confirm: z.boolean().optional(),
})
export type StartScanBody = z.infer<typeof startScanBody>

export const scaleScanBody = z
  .strictObject(scalingShape)
  .refine((body) => body.workers !== undefined || body.processes !== undefined, 'workers or processes is required')
export type ScaleScanBody = z.infer<typeof scaleScanBody>

export const restartScanBody = z.strictObject({
  name: text(SCAN_NAME_MAX_LENGTH).optional(),
  settings: z.strictObject(scalingShape).optional(),
})
export type RestartScanBody = z.infer<typeof restartScanBody>

/** `?task`: a task id or the name of one of the caller's tasks. */
const taskFilter = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, 'must be a task id or name')

export const listScansQuery = z.strictObject({
  state: qList(z.enum(SCAN_STATES), SCAN_STATES.length).optional(),
  task: taskFilter.optional(),
  limit: qInt(1, MAX_PAGE_LIMIT).optional(),
  cursor: cursorQuery.optional(),
  ...userIdFilterShape,
})
export type ListScansQuery = z.infer<typeof listScansQuery>

export const getScanQuery = z.strictObject(waitQueryShape)

/** `?type`: an exact event type (`scan.stateChanged`) or a prefix ending in a dot (`scan.`, `worker.`). */
export const listScanEventsQuery = z.strictObject({
  type: z.string().regex(/^[a-z][A-Za-z]{0,31}(\.([A-Za-z]{1,64})?)?$/, 'must be an event type or a prefix such as "scan."').optional(),
  limit: qInt(1, MAX_PAGE_LIMIT).optional(),
  cursor: cursorQuery.optional(),
})
export type ListScanEventsQuery = z.infer<typeof listScanEventsQuery>

export const listScanWorkersQuery = z.strictObject({
  state: qList(z.enum(WORKER_STATES), WORKER_STATES.length).optional(),
  limit: qInt(1, MAX_PAGE_LIMIT).optional(),
  cursor: cursorQuery.optional(),
})
export type ListScanWorkersQuery = z.infer<typeof listScanWorkersQuery>

export const workerLogsQuery = z.strictObject({
  wait: qInt(0, WORKER_LOGS_MAX_WAIT_SECONDS).optional(),
  tailBytes: qInt(1024, WORKER_LOGS_MAX_TAIL_BYTES).optional(),
})
export type WorkerLogsQuery = z.infer<typeof workerLogsQuery>
