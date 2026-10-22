import type { ScanSettingsInput } from '#shared/schemas/scans'
import { MAX_TIMEOUT_MS } from '#shared/schemas/scans'
import type { ValidationIssue } from '#shared/types/common'
import { SLUG_PATTERN } from '#shared/utils/slug'
import type { ScanSettingsDefaultsDoc, ScanSettingsDoc } from '../../types/documents'
import type { Config } from '../../utils/config'

// Effective scan settings (docs/data-model.md §4.5.1): the request's partial settings merged over the revision's
// settingsDefaults (the manifest defaults normalised by check-static), with `privileged` always copied from the
// revision and `nodeSelector.pool` defaulting to `shared`. The merged settings are checked against the static bounds
// and the instance limits (docs/api.md §5.1 step 7: 400 validationFailed with `settings.<field>` paths).

export const DEFAULT_POOL = 'shared'

/** Fallbacks when the manifest omits a default (identical to the manifest schema defaults). */
export const SETTINGS_FALLBACKS: ScanSettingsDefaultsDoc = {
  workers: 1,
  processes: 1,
  timeoutMs: 300_000,
  maxAttempts: 3,
  backoff: { initialMs: 5000, factor: 2, maxMs: 600_000, jitter: true },
  resources: { cpus: 1, memoryMiB: 512 },
  maxAnalysesPerProcess: 1000,
  privileged: false,
}

export function mergeSettings(
  defaults: Partial<ScanSettingsDefaultsDoc> | null | undefined,
  input: ScanSettingsInput | undefined,
  privileged: boolean,
): ScanSettingsDoc {
  const base = { ...SETTINGS_FALLBACKS, ...defaults }
  return {
    workers: input?.workers ?? base.workers,
    processes: input?.processes ?? base.processes,
    timeoutMs: input?.timeoutMs ?? base.timeoutMs,
    maxAttempts: input?.maxAttempts ?? base.maxAttempts,
    backoff: { ...SETTINGS_FALLBACKS.backoff, ...base.backoff, ...stripUndefined(input?.backoff) },
    resources: { ...SETTINGS_FALLBACKS.resources, ...base.resources, ...stripUndefined(input?.resources) },
    maxAnalysesPerProcess: input?.maxAnalysesPerProcess ?? base.maxAnalysesPerProcess,
    nodeSelector: {
      pool: input?.nodeSelector?.pool ?? DEFAULT_POOL,
      labels: { ...input?.nodeSelector?.labels },
    },
    privileged,
  }
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

export type SettingsLimits = Pick<Config, 'maxWorkersPerScan' | 'maxProcessesPerWorker'>

function between(issues: ValidationIssue[], path: string, value: number, min: number, max: number, integer = true): void {
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    issues.push({ path, message: integer ? 'must be an integer' : 'must be a number' })
  } else if (value < min || value > max) {
    issues.push({ path, message: `must be between ${min} and ${max}` })
  }
}

/** Bounds of docs/data-model.md §4.5.1; empty when the settings are valid. */
export function settingsIssues(settings: ScanSettingsDoc, limits: SettingsLimits): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  between(issues, 'settings.workers', settings.workers, 1, limits.maxWorkersPerScan)
  between(issues, 'settings.processes', settings.processes, 1, limits.maxProcessesPerWorker)
  between(issues, 'settings.timeoutMs', settings.timeoutMs, 1000, MAX_TIMEOUT_MS)
  between(issues, 'settings.maxAttempts', settings.maxAttempts, 1, 20)
  between(issues, 'settings.backoff.initialMs', settings.backoff.initialMs, 1000, MAX_TIMEOUT_MS)
  between(issues, 'settings.backoff.factor', settings.backoff.factor, 1, 10, false)
  between(issues, 'settings.backoff.maxMs', settings.backoff.maxMs, 1000, MAX_TIMEOUT_MS)
  if (settings.backoff.initialMs > settings.backoff.maxMs) {
    issues.push({ path: 'settings.backoff.maxMs', message: 'must be at least backoff.initialMs' })
  }
  between(issues, 'settings.resources.cpus', settings.resources.cpus, 0.1, 64, false)
  between(issues, 'settings.resources.memoryMiB', settings.resources.memoryMiB, 64, 65_536)
  between(issues, 'settings.maxAnalysesPerProcess', settings.maxAnalysesPerProcess, 1, 1_000_000)
  if (!SLUG_PATTERN.test(settings.nodeSelector.pool)) issues.push({ path: 'settings.nodeSelector.pool', message: 'must be a pool slug' })
  return issues
}

/** RabbitMQ `x-consumer-timeout` of the scan queue: timeoutMs + SCANTOR_UPLOAD_TIMEOUT + 5 min (docs/queue.md §3.3). */
export function consumerTimeoutMs(settings: Pick<ScanSettingsDoc, 'timeoutMs'>, uploadTimeoutMs: number): number {
  return settings.timeoutMs + uploadTimeoutMs + 300_000
}
