import { describe, expect, it } from 'vitest'
import { consumerTimeoutMs, mergeSettings, SETTINGS_FALLBACKS, settingsIssues } from '../../../server/services/configs/settings'

// Effective scan settings (docs/data-model.md §4.5.1; docs/api.md §5.1 step 7).

const limits = { maxWorkersPerScan: 100, maxProcessesPerWorker: 64 }

describe('mergeSettings', () => {
  it('uses the fallbacks when the revision has no defaults', () => {
    expect(mergeSettings(null, undefined, false)).toEqual({ ...SETTINGS_FALLBACKS, nodeSelector: { pool: 'shared', labels: {} }, privileged: false })
  })

  it('merges the request over the revision defaults field by field', () => {
    const defaults = { ...SETTINGS_FALLBACKS, workers: 2, processes: 3, backoff: { initialMs: 10_000, factor: 3, maxMs: 60_000, jitter: false } }
    const merged = mergeSettings(defaults, { processes: 5, backoff: { factor: 2 }, resources: { memoryMiB: 1024 }, nodeSelector: { labels: { region: 'eu' } } }, true)
    expect(merged).toEqual({
      workers: 2,
      processes: 5,
      timeoutMs: 300_000,
      maxAttempts: 3,
      backoff: { initialMs: 10_000, factor: 2, maxMs: 60_000, jitter: false },
      resources: { cpus: 1, memoryMiB: 1024 },
      maxAnalysesPerProcess: 1000,
      nodeSelector: { pool: 'shared', labels: { region: 'eu' } },
      privileged: true,
    })
  })

  it('never takes privileged from the request', () => {
    expect(mergeSettings({ ...SETTINGS_FALLBACKS, privileged: true }, { workers: 1 }, false).privileged).toBe(false)
  })
})

describe('settingsIssues', () => {
  const valid = mergeSettings(null, undefined, false)

  it('accepts the fallbacks', () => {
    expect(settingsIssues(valid, limits)).toEqual([])
  })

  it('enforces the instance limits', () => {
    expect(settingsIssues({ ...valid, workers: 101, processes: 65 }, limits)).toEqual([
      { path: 'settings.workers', message: 'must be between 1 and 100' },
      { path: 'settings.processes', message: 'must be between 1 and 64' },
    ])
  })

  it('enforces the static bounds', () => {
    const issues = settingsIssues(
      {
        ...valid,
        timeoutMs: 999,
        maxAttempts: 21,
        backoff: { initialMs: 5000, factor: 11, maxMs: 4000, jitter: true },
        resources: { cpus: 0.05, memoryMiB: 63 },
        maxAnalysesPerProcess: 0,
        nodeSelector: { pool: 'Not A Slug', labels: {} },
      },
      limits,
    )
    expect(issues.map((issue) => issue.path)).toEqual([
      'settings.timeoutMs',
      'settings.maxAttempts',
      'settings.backoff.factor',
      'settings.backoff.maxMs',
      'settings.resources.cpus',
      'settings.resources.memoryMiB',
      'settings.maxAnalysesPerProcess',
      'settings.nodeSelector.pool',
    ])
  })

  it('requires integers where the data model says int', () => {
    expect(settingsIssues({ ...valid, workers: 1.5 }, limits)).toEqual([{ path: 'settings.workers', message: 'must be an integer' }])
  })
})

describe('consumerTimeoutMs', () => {
  it('is timeoutMs + SCANTOR_UPLOAD_TIMEOUT + 5 minutes', () => {
    expect(consumerTimeoutMs({ timeoutMs: 300_000 }, 900_000)).toBe(1_500_000)
  })
})
