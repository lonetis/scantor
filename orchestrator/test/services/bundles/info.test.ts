import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { bundleFileName, bundleImageName, bundleInfo, bundleRef, bundleSettings } from '../../../server/services/bundles/info'
import type { RevisionDoc } from '../../../server/types/documents'
import { parseConfig } from '../../../server/utils/config'
import { readRepoFile } from '../../helpers/repo'

// The bundle info (/scantor/bundle.json; schemas/bundle.schema.json, security.md BDL-1): an allowlist built from the
// revision document. The canonical example of the Go format package (internal/bundle/testdata/bundle.json) is what
// Node builds from the matching revision, so both sides agree on every key; nothing else of the document reaches it.

const canonical = JSON.parse(readRepoFile('internal/bundle/testdata/bundle.json')) as Record<string, unknown>
const schema = JSON.parse(readRepoFile('schemas/bundle.schema.json')) as Record<string, unknown>
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
const config = parseConfig({}).config

const USER_ID = '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11'
const TASK_ID = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
const REVISION_ID = 'c2a9e4b1-7d3f-4e5a-9b8c-1d2e3f4a5b6c'
const DIGEST = `sha256:${'d'.repeat(64)}`

/** The echo@3 revision of the canonical example, with every internal field a revision document carries. */
function echoRevision(overrides: Partial<RevisionDoc> = {}): RevisionDoc {
  const description = structuredClone((canonical.description as RevisionDoc['description'])!)
  return {
    _id: REVISION_ID,
    userId: USER_ID,
    taskId: TASK_ID,
    taskName: 'echo',
    number: 3,
    state: 'ready',
    message: 'third',
    source: {
      kind: 'git',
      packSha256: 'a'.repeat(64),
      packBytes: 1234,
      fileCount: 4,
      git: { url: 'https://git.example.org/me/echo.git', ref: 'main', path: '.', commit: 'b'.repeat(40), dirty: false },
    },
    snapshotKey: `snapshots/${TASK_ID}/${'a'.repeat(64)}.tar.gz`,
    manifest: { scantor: 1, name: 'echo', language: 'python', entry: 'main.py', defaults: { timeout: '5m' } },
    language: 'python',
    baseImage: { ref: 'ghcr.io/lonetis/scantor-base-python:1.4.0', digest: `sha256:${'c'.repeat(64)}` },
    image: { repository: `tasks/${TASK_ID}`, tag: REVISION_ID, digest: DIGEST, bytes: 123_456_789, platform: { os: 'linux', arch: 'amd64' } },
    description,
    settingsDefaults: {
      workers: 4,
      processes: 1,
      timeoutMs: 300_000,
      maxAttempts: 3,
      backoff: { initialMs: 5000, factor: 2, maxMs: 600_000, jitter: true },
      resources: { cpus: 1, memoryMiB: 512 },
      maxAnalysesPerProcess: 1000,
      privileged: false,
    },
    privileged: false,
    buildLogKey: `build-logs/${REVISION_ID}.ndjson`,
    errors: [],
    jobId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    createdAt: new Date('2026-11-20T08:00:00Z'),
    startedAt: new Date('2026-11-20T08:00:01Z'),
    finishedAt: new Date('2026-11-20T08:01:00Z'),
    updatedAt: new Date('2026-11-20T08:01:00Z'),
    ...overrides,
  }
}

describe('bundle names', () => {
  it('mirror Go bundle.ImageName and bundle.FileName', () => {
    expect(bundleImageName('echo', 3)).toBe('localhost/scantor/echo:3')
    expect(bundleRef('echo', 3)).toBe('echo@3')
    expect(bundleFileName('echo', 3, { os: 'linux', arch: 'amd64' })).toBe('echo-3-linux-amd64.bundle.tar.gz')
    // The variant is not part of the name: arm64 images that report v8 keep the plain name.
    expect(bundleFileName('echo', 3, { os: 'linux', arch: 'arm64', variant: 'v8' } as never)).toBe('echo-3-linux-arm64.bundle.tar.gz')
  })
})

describe('bundleInfo', () => {
  it('builds the canonical example of internal/bundle from the matching revision', () => {
    const info = bundleInfo(echoRevision(), config)
    expect(info).toEqual(canonical)
    expect(validate(info), JSON.stringify(validate.errors)).toBe(true)
  })

  it('copies only allowlisted values: no ids, keys, digests, git sources, workers or extra description fields', () => {
    const revision = echoRevision()
    const description = revision.description as unknown as Record<string, unknown>
    description.internal = 'description extra'
    ;(description.connector as Record<string, unknown>).buildHost = 'builder.internal'
    ;(description.schedule as Record<string, unknown>).template = 'single'
    ;(revision.image!.platform as Record<string, unknown>).variant = 'v8'
    ;(revision.settingsDefaults as unknown as Record<string, unknown>).nodeSelector = { pool: 'secret-pool', labels: {} }
    const info = bundleInfo(revision, config)
    expect(validate(info), JSON.stringify(validate.errors)).toBe(true)
    const text = JSON.stringify(info)
    for (const value of [
      USER_ID,
      TASK_ID,
      REVISION_ID,
      DIGEST,
      'snapshots/',
      'build-logs/',
      'git.example.org',
      'description extra',
      'builder.internal',
      'secret-pool',
      'scantor-base-python',
    ]) {
      expect(text, value).not.toContain(value)
    }
    expect(Object.keys(info.settings).sort()).toEqual(['backoff', 'maxAnalysesPerProcess', 'maxAttempts', 'processes', 'resources', 'timeoutMs'])
    expect(info.platform).toEqual({ os: 'linux', arch: 'amd64' })
  })

  it('takes the platform limits of this master and drops the schedule template of a custom schedule', () => {
    const custom = echoRevision()
    custom.description!.schedule = { kind: 'custom', template: undefined }
    const info = bundleInfo(custom, { ...config, maxResultBytes: 2048, maxProcessesPerWorker: 8, maxFilesPerAnalysis: 3 })
    expect(info.description.schedule).toEqual({ kind: 'custom' })
    expect(info.limits).toEqual({
      maxAnalysisConfigBytes: config.maxAnalysisConfigBytes,
      maxResultBytes: 2048,
      maxFileBytes: config.maxFileBytes,
      maxFilesPerAnalysis: 3,
      logTailBytes: 32 * 1024,
      logTailEarlierBytes: 4 * 1024,
      maxProcesses: 8,
    })
    expect(validate(info), JSON.stringify(validate.errors)).toBe(true)
  })

  it('accepts SCANTOR_MAX_FILES_PER_ANALYSIS=0 (analyses store no files)', () => {
    const info = bundleInfo(echoRevision(), { ...config, maxFilesPerAnalysis: 0 })
    expect(info.limits.maxFilesPerAnalysis).toBe(0)
    expect(validate(info), JSON.stringify(validate.errors)).toBe(true)
  })

  it('fills settings the defaults lack with the fallbacks', () => {
    expect(bundleSettings({ settingsDefaults: { processes: 2 } as never })).toEqual({
      processes: 2,
      timeoutMs: 300_000,
      maxAttempts: 3,
      backoff: { initialMs: 5000, factor: 2, maxMs: 600_000, jitter: true },
      resources: { cpus: 1, memoryMiB: 512 },
      maxAnalysesPerProcess: 1000,
    })
  })

  it('refuses a revision without its build outputs', () => {
    expect(() => bundleInfo(echoRevision({ image: null }), config)).toThrow(/no image/)
    expect(() => bundleInfo(echoRevision({ description: null }), config)).toThrow(/no describe output/)
    expect(() => bundleInfo(echoRevision({ manifest: { name: 'echo' } }), config)).toThrow(/no entry/)
  })
})
