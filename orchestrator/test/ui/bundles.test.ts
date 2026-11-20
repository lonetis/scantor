import { describe, expect, it } from 'vitest'
import type { Bundle } from '../../shared/types/bundles'
import { BUNDLE_STATES } from '../../shared/utils/enums'
import {
  BUNDLE_WARNING,
  bundleCommandLines,
  bundleDownloadFresh,
  bundleElapsedMs,
  bundleExpiryLabel,
  bundlePlatformLabel,
  bundleSizeLabel,
  canBundle,
  isBundleActive,
} from '../../app/utils/bundles'
import { STATUS_STATES, statusMeta } from '../../app/utils/status'

// The revision page's "Bundle" button and BundleModal (docs/ui.md §5.9): which revisions can be bundled, which bundle
// states are polled, and the labels of a ready bundle.

const NOW = Date.parse('2026-11-20T09:05:00.000Z')

/** The spec's example bundle (docs/api.md §2), in another state when given. */
function bundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: '5d0c7a4e-2b1f-4c3d-9e8a-7f6b5c4d3e2f',
    revision: { id: 'c2a9e4b1-7d3f-4e5a-9b8c-1d2e3f4a5b6c', number: 3, ref: 'echo@3' },
    state: 'ready',
    image: 'localhost/scantor/echo:3',
    platform: { os: 'linux', arch: 'amd64' },
    bytes: 61_234_567,
    sha256: '9f2c0000000000000000000000000000000000000000000000000000000000e1',
    scantorVersion: '1.6.0',
    error: null,
    createdAt: '2026-11-20T09:00:00.000Z',
    startedAt: '2026-11-20T09:00:01.000Z',
    finishedAt: '2026-11-20T09:01:12.000Z',
    expiresAt: '2026-11-27T09:01:12.000Z',
    download: {
      url: 'https://s3.example.org/bundles/x.tar.gz?X-Amz-Signature=s',
      expiresAt: '2026-11-20T09:11:12.000Z',
      fileName: 'echo-3-linux-amd64.bundle.tar.gz',
    },
    commands: {
      load: 'docker load -i echo-3-linux-amd64.bundle.tar.gz',
      run: 'docker run --rm -v "$PWD:/work" localhost/scantor/echo:3',
      describe: 'docker run --rm localhost/scantor/echo:3 --describe',
    },
    ...overrides,
  }
}

describe('canBundle', () => {
  it('enables the button for ready, unprivileged revisions only', () => {
    expect(canBundle({ state: 'ready', privileged: false })).toEqual({ enabled: true, reason: null })
    for (const state of ['queued', 'building'] as const) {
      expect(canBundle({ state, privileged: false })).toEqual({ enabled: false, reason: 'Only ready revisions can be bundled; this one is still building' })
    }
    expect(canBundle({ state: 'failed', privileged: false })).toEqual({ enabled: false, reason: 'Failed revisions cannot be bundled' })
    expect(canBundle({ state: 'ready', privileged: true })).toEqual({ enabled: false, reason: 'Privileged revisions cannot be bundled' })
  })

  it('checks the state before the privileged flag, like the server', () => {
    expect(canBundle({ state: 'building', privileged: true }).reason).toMatch(/^Only ready revisions/)
  })

  it('is disabled while the revision loads', () => {
    expect(canBundle(null).enabled).toBe(false)
    expect(canBundle(undefined).reason).toBe('The revision is loading')
  })
})

describe('isBundleActive', () => {
  it('polls queued and running bundles only', () => {
    expect(BUNDLE_STATES.filter((state) => isBundleActive(state))).toEqual(['queued', 'running'])
    expect(isBundleActive(null)).toBe(false)
    expect(isBundleActive(undefined)).toBe(false)
  })
})

describe('bundle labels', () => {
  it('names the platform with its variant', () => {
    expect(bundlePlatformLabel({ os: 'linux', arch: 'amd64' })).toBe('linux/amd64')
    expect(bundlePlatformLabel({ os: 'linux', arch: 'arm64', variant: 'v8' })).toBe('linux/arm64/v8')
  })

  it('shows the size of a ready bundle in binary units', () => {
    expect(bundleSizeLabel(bundle())).toBe('58 MiB')
    expect(bundleSizeLabel(bundle({ state: 'running', bytes: null }))).toBe('–')
  })

  it('tells when the bundle expires', () => {
    expect(bundleExpiryLabel(bundle(), NOW)).toBe('expires in 7 days')
    expect(bundleExpiryLabel(bundle({ expiresAt: '2026-11-20T09:35:00.000Z' }), NOW)).toBe('expires in 30 min')
    expect(bundleExpiryLabel(bundle({ expiresAt: '2026-11-20T09:00:00.000Z' }), NOW)).toBe('expired')
    expect(bundleExpiryLabel(bundle({ expiresAt: 'never' }), NOW)).toBe('–')
  })

  it('counts the elapsed time until the bundle settled', () => {
    expect(bundleElapsedMs(bundle(), NOW)).toBe(72_000)
    expect(bundleElapsedMs(bundle({ state: 'running', finishedAt: null }), NOW)).toBe(300_000)
    expect(bundleElapsedMs(bundle({ state: 'queued', finishedAt: null, createdAt: '2026-11-20T09:06:00.000Z' }), NOW)).toBe(0)
  })

  it('lists the recipient commands in the order they are used', () => {
    const lines = bundleCommandLines(bundle())
    expect(lines.map((line) => [line.key, line.title])).toEqual([
      ['load', 'Load once'],
      ['run', 'Run'],
      ['describe', 'Describe'],
    ])
    expect(lines[1]!.code).toBe('docker run --rm -v "$PWD:/work" localhost/scantor/echo:3')
  })

  it('warns that a bundle discloses the whole task image', () => {
    expect(BUNDLE_WARNING).toBe(
      'A bundle contains the complete task image, including every file of the task folder. Anyone with the file can run and inspect it.',
    )
  })
})

describe('bundleDownloadFresh', () => {
  it('re-reads a link that expires within 30 s', () => {
    expect(bundleDownloadFresh(bundle(), NOW)).toBe(true)
    expect(bundleDownloadFresh(bundle(), Date.parse('2026-11-20T09:10:41.000Z'))).toBe(true)
    expect(bundleDownloadFresh(bundle(), Date.parse('2026-11-20T09:10:42.000Z'))).toBe(false)
    expect(bundleDownloadFresh(bundle({ download: null }), NOW)).toBe(false)
  })
})

describe('bundle status badge', () => {
  it('colors every bundle state like exports (docs/ui.md §10)', () => {
    expect([...STATUS_STATES.bundle]).toEqual([...BUNDLE_STATES])
    expect(Object.fromEntries(BUNDLE_STATES.map((state) => [state, statusMeta('bundle', state).color]))).toEqual({
      queued: 'neutral',
      running: 'info',
      ready: 'success',
      failed: 'error',
    })
    for (const state of BUNDLE_STATES) {
      expect(statusMeta('bundle', state).label).toBe(state)
      expect(statusMeta('bundle', state).pulse).toBe(false)
    }
  })
})
