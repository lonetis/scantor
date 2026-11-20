import { afterEach, describe, expect, it } from 'vitest'
import { bundleCommands, isBundleSettled, toApiBundle } from '../../../server/services/bundles/mappers'
import type { BundleDoc } from '../../../server/types/documents'
import { parseConfig, setConfigForTesting } from '../../../server/utils/config'
import { readRepoFile } from '../../helpers/repo'

// The Bundle representation (docs/api.md §2): the shape of the Go example (internal/api/testdata/examples.json, which
// mirrors docs/api.md), no internal fields, the recipient commands, and a presigned application/gzip attachment of the
// archive for ready bundles only (security.md BDL-3).

const example = (JSON.parse(readRepoFile('internal/api/testdata/examples.json')) as Record<string, Record<string, unknown>>).Bundle!

const TASK_ID = '7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'
const BUNDLE_ID = '5d0c7a4e-2b1f-4c3d-9e8a-7f6b5c4d3e2f'

function readyDoc(overrides: Partial<BundleDoc> = {}): BundleDoc {
  return {
    _id: BUNDLE_ID,
    userId: '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11',
    taskId: TASK_ID,
    taskName: 'echo',
    revisionId: 'c2a9e4b1-7d3f-4e5a-9b8c-1d2e3f4a5b6c',
    revisionNumber: 3,
    state: 'ready',
    image: 'localhost/scantor/echo:3',
    platform: { os: 'linux', arch: 'amd64' },
    key: `bundles/${TASK_ID}/${BUNDLE_ID}.tar.gz`,
    fileName: 'echo-3-linux-amd64.bundle.tar.gz',
    bytes: 61_234_567,
    sha256: '9f2c…e1',
    scantorVersion: '1.6.0',
    jobId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    error: null,
    createdAt: new Date('2026-11-20T09:00:00.000Z'),
    updatedAt: new Date('2026-11-20T09:01:12.000Z'),
    startedAt: new Date('2026-11-20T09:00:01.000Z'),
    finishedAt: new Date('2026-11-20T09:01:12.000Z'),
    expiresAt: new Date('2026-11-27T09:01:12.000Z'),
    ...overrides,
  }
}

describe('toApiBundle', () => {
  afterEach(() => setConfigForTesting(null))

  it('matches the documented example and presigns an application/gzip attachment named fileName', async () => {
    setConfigForTesting(parseConfig({ SCANTOR_S3_PUBLIC_URL: 'https://s3.example.org', SCANTOR_S3_BUCKET: 'scantor' }).config)
    const before = Date.now()
    const bundle = await toApiBundle(readyDoc())
    const { download, ...rest } = bundle
    const { download: exampleDownload, ...exampleRest } = example as { download: Record<string, unknown> }
    expect(rest).toEqual(exampleRest)
    expect(download?.fileName).toBe(exampleDownload.fileName)
    expect(Object.keys(download!).sort()).toEqual(Object.keys(exampleDownload).sort())

    const url = new URL(download!.url)
    expect(`${url.origin}${url.pathname}`).toBe(`https://s3.example.org/scantor/bundles/${TASK_ID}/${BUNDLE_ID}.tar.gz`)
    expect(url.searchParams.get('response-content-type')).toBe('application/gzip')
    expect(url.searchParams.get('response-content-disposition')).toMatch(/^attachment; filename="echo-3-linux-amd64\.bundle\.tar\.gz"/)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    const expiresAt = Date.parse(download!.expiresAt)
    expect(expiresAt).toBeGreaterThanOrEqual(before + 600_000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 600_000)
  })

  it('has no download before the bundle is ready and never exposes internal fields', async () => {
    for (const state of ['queued', 'running', 'failed'] as const) {
      const bundle = await toApiBundle(
        readyDoc({
          state,
          bytes: null,
          sha256: null,
          scantorVersion: null,
          finishedAt: null,
          error: state === 'failed' ? { code: 'bundleFailed', message: 'boom' } : null,
        }),
      )
      expect(bundle.download, state).toBeNull()
      expect(bundle.commands, state).toEqual(example.commands)
      const text = JSON.stringify(bundle)
      for (const value of [TASK_ID, 'bundles/', '0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11', '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'])
        expect(text, `${state}: ${value}`).not.toContain(value)
    }
    expect((await toApiBundle(readyDoc({ state: 'failed', error: { code: 'bundleFailed', message: 'boom' } }))).error).toEqual({
      code: 'bundleFailed',
      message: 'boom',
    })
  })

  it('shows the variant of the platform when the archive reported one', async () => {
    const bundle = await toApiBundle(readyDoc({ state: 'running', platform: { os: 'linux', arch: 'arm64', variant: 'v8' } }))
    expect(bundle.platform).toEqual({ os: 'linux', arch: 'arm64', variant: 'v8' })
  })
})

describe('bundleCommands and isBundleSettled', () => {
  it('quote the mount for the shell and settle on ready or failed', () => {
    expect(bundleCommands({ image: 'localhost/scantor/x:1', fileName: 'x-1-linux-arm64.bundle.tar.gz' })).toEqual({
      load: 'docker load -i x-1-linux-arm64.bundle.tar.gz',
      run: 'docker run --rm -v "$PWD:/work" localhost/scantor/x:1',
      describe: 'docker run --rm localhost/scantor/x:1 --describe',
    })
    expect(['queued', 'running', 'ready', 'failed'].filter((state) => isBundleSettled({ state: state as BundleDoc['state'] }))).toEqual(['ready', 'failed'])
  })
})
